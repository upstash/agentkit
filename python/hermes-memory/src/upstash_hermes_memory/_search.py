"""A Redis Search index that is created on first use, shared by AgentMemory and ChatHistory.

A store with its own `prefix` sends the commands `ReactiveSearchIndex` sends from the TS SDK,
argument for argument, so such an index is the same from either language (unless `semantic` makes
`text` HYBRID, which the TS SDK does not do yet). The default shared index is Python-only.
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
# `kind` ("memory" or "chat") keeps the two apart in every query.
SHARED_SCHEMA: list[Field] = [
    ("kind", "TEXT", True),
    ("userId", "TEXT", True),
    ("text", "TEXT", False),
    ("sessionId", "TEXT", True),
    ("userMessages", "TEXT", False),
    ("modelMessages", "TEXT", False),
]


def with_hybrid_text(schema: Sequence[Field]) -> list[Field]:
    """`schema` with the memory `text` field as HYBRID (full-text plus an embedding for `$ann`).

    Only `text` changes: chat transcripts stay TEXT, since a HYBRID field gets one embedding for
    its whole value and `userMessages` / `modelMessages` hold a whole session each.
    """
    return [(f, "HYBRID" if f == "text" else t, nt) for f, t, nt in schema]


def shared_index(redis: Any, namespace: str, *, semantic: bool = False) -> "SearchIndex":
    """The shared index of a namespace, covering `<namespace>:memory:` and `<namespace>:chat:`.

    Both stores build this same definition, so whichever reads first creates it and the other's
    EXISTSOK create is a no-op. `semantic` only decides what a new index is created with: an
    existing index with `text` as either TEXT or HYBRID is used as it is (see `SearchIndex.ensure`),
    and changing it is a maintenance step (`python -m upstash_hermes_memory.migrate`).
    """
    hybrid = with_hybrid_text(SHARED_SCHEMA)
    return SearchIndex(
        redis,
        name=index_name_for(namespace),
        prefix=[f"{namespace}:memory:", f"{namespace}:chat:"],
        schema=hybrid if semantic else SHARED_SCHEMA,
        accepted=[SHARED_SCHEMA, hybrid],
    )


def _is_config_mismatch(error: Exception) -> bool:
    return "different configuration" in str(error)


def describe(redis: Any, name: str) -> dict[str, Any] | None:
    """SEARCH.DESCRIBE as {"name", "type", "prefixes", "language", "schema"}, or None if missing.

    `name` is the index DESCRIBE resolved, which differs from the argument for an alias.

    Accepts the client's parsed `IndexDescription` as well as the raw reply, so it does not depend
    on the client knowing every field type (upstash-redis 1.8 has no HYBRID enum member).
    """
    raw = redis.execute(["SEARCH.DESCRIBE", name])
    if raw is None or raw == []:
        return None
    if isinstance(raw, list):
        pairs = dict(zip(raw[0::2], raw[1::2]))
        fields = [
            (f[0], str(f[1]).upper(), "NOTOKENIZE" in f[2:], "NOSTEM" in f[2:], "FROM" in f[2:])
            for f in pairs.get("schema") or []
        ]
        found_name = pairs.get("name")
        data_type, prefixes, language = (
            pairs.get("type"),
            pairs.get("prefixes"),
            pairs.get("language"),
        )
    else:
        fields = [
            (
                n,
                str(getattr(i.type, "value", i.type)).upper(),
                i.no_tokenize,
                i.no_stem,
                bool(i.alias),
            )
            for n, i in raw.schema.items()
        ]
        found_name = raw.name
        data_type, prefixes, language = raw.data_type, raw.prefixes, raw.language
    return {
        "name": found_name,
        "type": str(getattr(data_type, "value", data_type) or "").upper(),
        "prefixes": sorted(prefixes or []),
        "language": str(getattr(language, "value", language) or "").lower(),
        # NOSTEM and FROM are never set by this package, so their presence is a mismatch.
        "schema": sorted(fields),
    }


def matches(
    description: dict[str, Any] | None,
    prefixes: Sequence[str],
    schema: Sequence[Field],
    name: str | None = None,
) -> bool:
    """Whether a `describe()` result is exactly the index this package would create (and, with
    `name`, that index itself rather than an alias pointing at another one)."""
    if description is None:
        return False
    return (
        (name is None or description["name"] == name)
        and description["type"] == "JSON"
        and description["prefixes"] == sorted(prefixes)
        and description["language"] in ("", "english")
        and description["schema"] == sorted((f, t, nt, False, False) for f, t, nt in schema)
    )


class SearchIndex:
    def __init__(
        self,
        redis: Any,
        *,
        name: str,
        prefix: str | Sequence[str],
        schema: Sequence[Field],
        accepted: Sequence[Sequence[Field]] = (),
    ):
        self.redis = redis
        self.name = name
        self.prefixes = [prefix] if isinstance(prefix, str) else list(prefix)
        self.schema = list(schema)
        # Other definitions an existing index may have and still be used as it is.
        self.accepted = [list(s) for s in accepted if list(s) != self.schema]
        # The definition the index actually has, known once `ensure()` has run.
        self.actual_schema: list[Field] | None = None
        self._ready = False
        self._lock = threading.Lock()

    def field_type(self, field: str) -> str | None:
        """The type `field` has in the live index (after `ensure()`), e.g. "TEXT" or "HYBRID"."""
        return next((t for f, t, _ in self.actual_schema or [] if f == field), None)

    def create_command(self) -> list[str]:
        cmd = ["SEARCH.CREATE", self.name, "EXISTSOK", "ON", "JSON", "PREFIX"]
        cmd += [str(len(self.prefixes)), *self.prefixes]
        cmd.append("SCHEMA")
        for field, type_, no_tokenize in self.schema:
            cmd += [field, type_] + (["NOTOKENIZE"] if no_tokenize else [])
        return cmd

    def ensure(self) -> None:
        """Create the index if it does not exist yet. A no-op after the first call.

        An existing index whose definition differs only in a way this package knows (an `accepted`
        schema, such as `text` TEXT vs HYBRID) is used as it is, never dropped: rebuilding an index
        under running clients is unsafe, so it is left to `python -m upstash_hermes_memory.migrate`.
        """
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            try:
                self.redis.execute(self.create_command())
                actual = self.schema
            except Exception as error:
                if not (self.accepted and _is_config_mismatch(error)):
                    raise
                found = describe(self.redis, self.name)
                actual = next(
                    (s for s in self.accepted if matches(found, self.prefixes, s, self.name)), None
                )
                if actual is None:
                    raise
            # 1 once pending updates are searchable; 0 means the index is gone (dropped right
            # after the create): stay not-ready, so the next call creates it again.
            if self.redis.execute(["SEARCH.WAITINDEXING", self.name]) != 1:
                raise RuntimeError(f"search index {self.name} disappeared while it was created")
            self.actual_schema = list(actual)
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
