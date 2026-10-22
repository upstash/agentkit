"""Python port of `AgentMemory` from `@upstash/agentkit-sdk` (packages/sdk/src/memory.ts).

Same keys, same documents, same index: a memory saved by the TS SDK is recalled here and the other
way round, as long as both sides use the same prefix.

    key    <prefix>:<userId>:<id>
    value  JSON {"text", "userId", "createdAt" (epoch ms), ...metadata}
    index  SEARCH.CREATE <name> EXISTSOK ON JSON PREFIX 1 <prefix>: SCHEMA text TEXT userId TEXT NOTOKENIZE
"""

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ._search import SearchIndex, dumps, index_name_for
from ._telemetry import add_telemetry

DEFAULT_PREFIX = "agentkit:memory"

# The document's own fields. Metadata is spread next to them, so it must not replace them: a
# `userId` in metadata would move the memory into another user's searches.
RESERVED_FIELDS = frozenset({"text", "userId", "createdAt"})


def _check_id(value: str, what: str) -> None:
    """User and session ids sit in the middle of the key, so they may not contain `:`."""
    if not value or ":" in value:
        raise ValueError(f"{what} must be a non-empty string without ':' (got {value!r})")


def _check_memory_id(value: str) -> None:
    """The memory id is the last part of the key, so `:` is fine there (the TS SDK allows it)."""
    if not value:
        raise ValueError("id must be a non-empty string")


@dataclass
class MemoryRecord:
    id: str
    text: str
    created_at: int
    score: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class AgentMemory:
    def __init__(
        self,
        redis: Any,
        *,
        prefix: str = DEFAULT_PREFIX,
        index_name: str | None = None,
        min_score: float = 0,
        enable_telemetry: bool = True,
    ):
        self.redis = redis
        self.prefix = prefix
        self.min_score = min_score
        self.index = SearchIndex(
            redis,
            name=index_name or index_name_for(prefix),
            prefix=f"{prefix}:",
            schema=[("text", "TEXT", False), ("userId", "TEXT", True)],
        )
        add_telemetry(redis, enabled=enable_telemetry)

    def _key(self, user_id: str, id: str) -> str:
        return f"{self.prefix}:{user_id}:{id}"

    def add(
        self,
        text: str,
        *,
        user_id: str,
        id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> MemoryRecord:
        _check_id(user_id, "user_id")
        id = id or str(uuid.uuid4())
        _check_memory_id(id)
        reserved = RESERVED_FIELDS & set(metadata or {})
        if reserved:
            raise ValueError(f"metadata may not set {sorted(reserved)}")
        created_at = int(time.time() * 1000)
        doc = {"text": text, "userId": user_id, "createdAt": created_at, **(metadata or {})}
        self.redis.execute(["JSON.SET", self._key(user_id, id), "$", dumps(doc)])
        return MemoryRecord(id=id, text=text, created_at=created_at, metadata=metadata or {})

    def recall(self, query: str, *, user_id: str, top_k: int = 5) -> list[MemoryRecord]:
        """The `top_k` memories closest to `query` ($smart: full-text plus fuzzy matching)."""
        _check_id(user_id, "user_id")
        filter: dict[str, Any] = {"userId": {"$eq": user_id}}
        has_query = bool(query and query.strip())
        if has_query:
            filter["text"] = {"$smart": query}
        rows = self.index.query(filter, limit=top_k)
        min_score = self.min_score if has_query else 0
        return [
            r for r in (self._record(row, user_id) for row in rows) if (r.score or 0) >= min_score
        ]

    def list(self, *, user_id: str, limit: int = 100) -> list[MemoryRecord]:
        _check_id(user_id, "user_id")
        rows = self.index.query({"userId": {"$eq": user_id}}, limit=limit)
        return [self._record(row, user_id) for row in rows]

    def count(self, *, user_id: str) -> int:
        _check_id(user_id, "user_id")
        return self.index.count({"userId": {"$eq": user_id}})

    def get(self, id: str, *, user_id: str) -> MemoryRecord | None:
        _check_id(user_id, "user_id")
        _check_memory_id(id)
        doc = self.redis.execute(["JSON.GET", self._key(user_id, id)])
        if not isinstance(doc, dict):
            return None
        return self._from_doc(id, doc)

    def forget(self, id: str, *, user_id: str) -> bool:
        _check_id(user_id, "user_id")
        _check_memory_id(id)
        return bool(self.redis.delete(self._key(user_id, id)))

    def _record(self, row: Any, user_id: str) -> MemoryRecord:
        id = row.key[len(self._key(user_id, "")) :]
        record = self._from_doc(id, row.data if isinstance(row.data, dict) else {})
        record.score = row.score
        return record

    @staticmethod
    def _from_doc(id: str, doc: dict[str, Any]) -> MemoryRecord:
        metadata = {k: v for k, v in doc.items() if k not in RESERVED_FIELDS}
        return MemoryRecord(
            id=id,
            text=doc.get("text") or "",
            created_at=doc.get("createdAt") or 0,
            metadata=metadata,
        )
