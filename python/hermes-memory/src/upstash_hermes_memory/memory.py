"""Python port of `AgentMemory` from `@upstash/agentkit-sdk` (packages/sdk/src/memory.ts).

Same keys and documents as the TS SDK: a memory saved by the TS SDK is recalled here and the other
way round, as long as both sides use the same namespace (default `agentkit`). The search index is
not shared: Python indexes memories and chats together in one index (`agentkit`), the TS SDK
creates its own (`agentkit_memory`), and both index the same keys.

    key    <namespace>:memory:<userId>:<id>
    value  JSON {"text", "userId", "createdAt" (epoch ms), ...metadata}, exactly what the TS SDK writes
    index  the namespace's one shared index, with ChatHistory (see `_search.SHARED_SCHEMA`)

Chats in the shared index carry `kind: "chat"`; memories carry no `kind`, so a memory written by a
TS app is found here too. Every query excludes chat rows (`$mustNot`), so chats never use up a
`limit` or show up in `count`.
Passing `prefix` (or `index_name`) gives the store its own index over `<prefix>:` instead.
"""

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from upstash_redis.errors import UpstashError

from ._search import (
    DEFAULT_NAMESPACE,
    SearchIndex,
    dumps,
    index_name_for,
    shared_index,
    with_hybrid_text,
)
from ._telemetry import add_telemetry

logger = logging.getLogger(__name__)

DEFAULT_PREFIX = f"{DEFAULT_NAMESPACE}:memory"

# How often a failing semantic query or an index without embeddings is logged, per store.
_WARN_EVERY_S = 600.0

RecallMode = Literal["auto", "keyword"]

# What a failed hybrid query can raise: a server error (e.g. the intermittent "dot metric only
# accepts unit-length vectors") or a transport failure. Anything else is a bug and propagates.
_FALLBACK_ERRORS = (UpstashError, httpx.HTTPError)

# The document's own fields. Metadata is spread next to them, so it must not replace them: a
# `userId` in metadata would move the memory into another user's searches.
RESERVED_FIELDS = frozenset({"kind", "text", "userId", "createdAt"})


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
    # How a recalled record was found: "keyword" ($smart, BM25 score) or "hybrid" ($rrf of $smart
    # and $ann; the score is a rank-fusion value, only comparable within one query). None for
    # records that were not searched for (get, list, an empty query).
    retrieval: str | None = None


class AgentMemory:
    def __init__(
        self,
        redis: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
        prefix: str | None = None,
        index_name: str | None = None,
        min_score: float = 0,
        semantic: bool = False,
        enable_telemetry: bool = False,
    ):
        """`semantic=True` recalls with hybrid search (full-text plus meaning) when the index has
        `text` as a HYBRID field, and creates a new index that way. An existing TEXT index keeps
        working with keyword recall until it is migrated (`python -m upstash_hermes_memory.migrate`).
        `min_score` applies to keyword results only; hybrid scores are not on the same scale.
        """
        self.redis = redis
        self.min_score = min_score
        self.semantic = semantic
        self.shared = prefix is None and index_name is None
        self._warned_at: dict[str, float] = {}
        if self.shared:
            self.prefix = f"{namespace}:memory"
            self.index = shared_index(redis, namespace, semantic=semantic)
        else:
            self.prefix = prefix or DEFAULT_PREFIX
            text_schema = [("text", "TEXT", False), ("userId", "TEXT", True)]
            hybrid_schema = with_hybrid_text(text_schema)
            self.index = SearchIndex(
                redis,
                name=index_name or index_name_for(self.prefix),
                prefix=f"{self.prefix}:",
                schema=hybrid_schema if semantic else text_schema,
                accepted=[text_schema, hybrid_schema],
            )
        add_telemetry(redis, enabled=enable_telemetry)

    def _filter(self, user_id: str) -> dict[str, Any]:
        if not self.shared:
            return {"userId": {"$eq": user_id}}
        # Excluded in the query, not afterwards: a chat row counted against LIMIT would hide a
        # memory behind it. Memories have no `kind` and Search has no `$ne`, hence `$mustNot`.
        return {"userId": {"$eq": user_id}, "$mustNot": [{"kind": {"$eq": "chat"}}]}

    def _memories(self, rows: list[Any], user_id: str) -> list[Any]:
        """Only this store's rows: on the shared index, a user's chats match a userId filter too."""
        mine = self._key(user_id, "")
        return [row for row in rows if row.key.startswith(mine)]

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

    def recall(
        self, query: str, *, user_id: str, top_k: int = 5, mode: RecallMode = "auto"
    ) -> list[MemoryRecord]:
        """The `top_k` memories closest to `query`.

        `mode="auto"` uses hybrid search ($rrf of $smart and $ann) when this store is `semantic`
        and the index has embeddings, else keyword search ($smart: full-text plus fuzzy matching).
        A failed hybrid query falls back to keyword search once. `mode="keyword"` always uses
        keyword search, for callers that need COUNT and QUERY to describe the same set.
        """
        if mode not in ("auto", "keyword"):
            raise ValueError(f"mode must be 'auto' or 'keyword' (got {mode!r})")
        _check_id(user_id, "user_id")
        base = self._filter(user_id)
        if not (query and query.strip()):
            rows = self._memories(self.index.query(base, limit=top_k), user_id)
            return [self._record(row, user_id) for row in rows]
        if mode == "auto" and self.semantic and self._hybrid_ready():
            hybrid = {
                "$rrf": {
                    "retrievers": [
                        {**base, "text": {"$smart": query}},
                        {
                            "$ann": {
                                "field": "text",
                                "query": query,
                                "filter": self._filter(user_id),
                            }
                        },
                    ]
                }
            }
            try:
                rows = self._memories(self.index.query(hybrid, limit=top_k), user_id)
            except _FALLBACK_ERRORS as error:
                self._warn(
                    "hybrid", "upstash memory hybrid recall failed, using keyword: %s", error
                )
            else:
                return [self._record(row, user_id, "hybrid") for row in rows]
        rows = self._memories(
            self.index.query({**base, "text": {"$smart": query}}, limit=top_k), user_id
        )
        if not self.semantic and self.index.field_type("text") == "HYBRID":
            self._warn(
                "embeddings-unused",
                "upstash memory: index %s has embeddings but semantic recall is off; new memories "
                "are still embedded (migrate --to keyword to stop that)",
                self.index.name,
            )
        records = [self._record(row, user_id, "keyword") for row in rows]
        return [r for r in records if (r.score or 0) >= self.min_score]

    def _hybrid_ready(self) -> bool:
        """Whether the live index can answer `$ann` on `text` (it was created or migrated so)."""
        self.index.ensure()
        if self.index.field_type("text") == "HYBRID":
            return True
        self._warn(
            "no-embeddings",
            "upstash memory: semantic recall is on but index %s has no embeddings yet; using "
            "keyword recall until it is migrated (python -m upstash_hermes_memory.migrate)",
            self.index.name,
        )
        return False

    def _warn(self, what: str, message: str, *args: Any) -> None:
        now = time.monotonic()
        if now - self._warned_at.get(what, -_WARN_EVERY_S) >= _WARN_EVERY_S:
            self._warned_at[what] = now
            logger.warning(message, *args)

    def list(self, *, user_id: str, limit: int = 100) -> list[MemoryRecord]:
        _check_id(user_id, "user_id")
        rows = self._memories(self.index.query(self._filter(user_id), limit=limit), user_id)
        return [self._record(row, user_id) for row in rows]

    def count(self, *, user_id: str) -> int:
        _check_id(user_id, "user_id")
        return self.index.count(self._filter(user_id))

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

    def _record(self, row: Any, user_id: str, retrieval: str | None = None) -> MemoryRecord:
        id = row.key[len(self._key(user_id, "")) :]
        record = self._from_doc(id, row.data if isinstance(row.data, dict) else {})
        record.score = row.score
        record.retrieval = retrieval
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
