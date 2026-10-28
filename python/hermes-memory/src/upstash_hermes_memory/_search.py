"""A Redis Search index that is created on first use, shared by AgentMemory and ChatHistory.

The commands are the ones `ReactiveSearchIndex` sends from the TS SDK, argument for argument, so
an index created from either language is the same index.
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


class SearchIndex:
    def __init__(self, redis: Any, *, name: str, prefix: str, schema: Sequence[Field]):
        self.redis = redis
        self.name = name
        self.prefix = prefix
        self.schema = list(schema)
        self._ready = False
        self._lock = threading.Lock()

    def create_command(self) -> list[str]:
        cmd = ["SEARCH.CREATE", self.name, "EXISTSOK", "ON", "JSON", "PREFIX", "1", self.prefix]
        cmd.append("SCHEMA")
        for field, type_, no_tokenize in self.schema:
            cmd += [field, type_] + (["NOTOKENIZE"] if no_tokenize else [])
        return cmd

    def ensure(self) -> None:
        """Create the index if it does not exist yet. A no-op after the first call."""
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            self.redis.execute(self.create_command())
            self.redis.execute(["SEARCH.WAITINDEXING", self.name])
            self._ready = True

    def query(self, filter: dict[str, Any], limit: int | None = None) -> list[Any]:
        self.ensure()
        rows = self._query(filter, limit)
        if not rows and self._raw_count(filter) < 0:
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
        """Block until every write so far is searchable (and every delete has left the index)."""
        self.ensure()
        self.redis.execute(["SEARCH.WAITINDEXING", self.name])

    def drop(self) -> None:
        self.redis.execute(["SEARCH.DROP", self.name])
        self._ready = False
