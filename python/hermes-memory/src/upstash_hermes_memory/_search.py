"""A Redis Search index that is created on first use, shared by AgentMemory and ChatHistory.

A store with its own `prefix` sends the commands `ReactiveSearchIndex` sends from the TS SDK,
argument for argument, except that memory `text` is HYBRID here (the TS SDK still creates it as
TEXT), so the two languages cannot share an index over the same name. The default shared index is
Python-only.
"""

import json
import threading
from collections.abc import Sequence
from typing import Any

# (field, type, no_tokenize)
Field = tuple[str, str, bool]


def index_name_for(prefix: str) -> str:
    """The TS default: every character outside [a-zA-Z0-9_] becomes `_`."""
    return "".join(c if c.isascii() and (c.isalnum() or c == "_") else "_" for c in prefix)


def dumps(value: Any) -> str:
    """JSON the way JSON.stringify writes it, so stored documents match the TS SDK's."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


DEFAULT_NAMESPACE = "agentkit"

# Retrievers ($rrf, $ann) must be the only key of the query object and cannot be counted.
RETRIEVERS = frozenset({"$rrf", "$ann"})

# The one index AgentMemory and ChatHistory share by default (Python only: the TS SDK gives each
# store its own index). Upstash's Free plan allows one search index per database.
# `kind` ("memory" or "chat") keeps the two apart in every query. Only the memory `text` is HYBRID
# (full-text plus an embedding for `$ann`): chat transcripts stay TEXT, since a HYBRID field gets
# one embedding for its whole value and `userMessages` / `modelMessages` hold a whole session each.
SHARED_SCHEMA: list[Field] = [
    ("kind", "TEXT", True),
    ("userId", "TEXT", True),
    ("text", "HYBRID", False),
    ("sessionId", "TEXT", True),
    ("userMessages", "TEXT", False),
    ("modelMessages", "TEXT", False),
]


def shared_index(redis: Any, namespace: str) -> "SearchIndex":
    """The shared index of a namespace, covering `<namespace>:memory:` and `<namespace>:chat:`.

    Both stores build this same definition, so whichever reads first creates it and the other's
    EXISTSOK create is a no-op.
    """
    return SearchIndex(
        redis,
        name=index_name_for(namespace),
        prefix=[f"{namespace}:memory:", f"{namespace}:chat:"],
        schema=SHARED_SCHEMA,
    )


def _is_config_mismatch(error: Exception) -> bool:
    return "different configuration" in str(error)


class SearchIndex:
    def __init__(
        self, redis: Any, *, name: str, prefix: str | Sequence[str], schema: Sequence[Field]
    ):
        self.redis = redis
        self.name = name
        self.prefixes = [prefix] if isinstance(prefix, str) else list(prefix)
        self.schema = list(schema)
        self._ready = False
        self._lock = threading.Lock()

    def create_command(self) -> list[str]:
        cmd = ["SEARCH.CREATE", self.name, "EXISTSOK", "ON", "JSON", "PREFIX"]
        cmd += [str(len(self.prefixes)), *self.prefixes]
        cmd.append("SCHEMA")
        for field, type_, no_tokenize in self.schema:
            cmd += [field, type_] + (["NOTOKENIZE"] if no_tokenize else [])
        return cmd

    def ensure(self) -> None:
        """Create the index if it does not exist yet. A no-op after the first call.

        An index of this name with another definition (one from 0.2.x has `text` as TEXT) is never
        dropped here, since other clients may be using it; the error says how to replace it.
        """
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            try:
                self.redis.execute(self.create_command())
            except Exception as error:
                if not _is_config_mismatch(error):
                    raise
                raise RuntimeError(
                    f"search index {self.name} exists with a different definition, for example "
                    f"from upstash-hermes-memory 0.2.x. Stop every client, run `SEARCH.DROP "
                    f"{self.name}` (documents are kept and indexed again) and start again."
                ) from error
            # 1 once pending updates are searchable; 0 means the index is gone (dropped right
            # after the create): stay not-ready, so the next call creates it again.
            if self.redis.execute(["SEARCH.WAITINDEXING", self.name]) != 1:
                raise RuntimeError(f"search index {self.name} disappeared while it was created")
            self._ready = True

    def query(self, filter: dict[str, Any], limit: int | None = None) -> list[Any]:
        self.ensure()
        rows = self._query(filter, limit)
        # COUNT cannot take a retriever, so a retriever query checks the index with `{}` instead.
        probe = {} if RETRIEVERS & set(filter) else filter
        if not rows and self._raw_count(probe) < 0:
            # The Python client turns a missing index into [], so an empty result is ambiguous.
            # COUNT says -1 when the index is gone (another client dropped it): recreate, retry once.
            self._ready = False
            self.ensure()
            rows = self._query(filter, limit)
        return rows

    def count(self, filter: dict[str, Any]) -> int:
        self.ensure()
        count = self._raw_count(filter)
        if count < 0:
            # -1 means the index is gone (dropped after we created it): recreate it and retry once.
            self._ready = False
            self.ensure()
            count = self._raw_count(filter)
        return max(count, 0)

    def _query(self, filter: dict[str, Any], limit: int | None) -> list[Any]:
        cmd = ["SEARCH.QUERY", self.name, dumps(filter)]
        if limit is not None:
            cmd += ["LIMIT", str(limit)]
        return list(self.redis.execute(cmd) or [])

    def _raw_count(self, filter: dict[str, Any]) -> int:
        result = self.redis.execute(["SEARCH.COUNT", self.name, dumps(filter)])
        return int(getattr(result, "count", result))

    def wait_indexing(self) -> None:
        """Block until every write so far is searchable (and every delete has left the index).

        WAITINDEXING answers 0 when the index is gone (another client dropped it): it is created
        again (its documents are indexed by the create-time scan) and waited for once more.
        """
        self.ensure()
        if self.redis.execute(["SEARCH.WAITINDEXING", self.name]) != 1:
            self._ready = False
            self.ensure()

    def drop(self) -> None:
        self.redis.execute(["SEARCH.DROP", self.name])
        self._ready = False
