"""Python port of `ChatHistory` from `@upstash/agentkit-sdk` (packages/sdk/src/chat-history.ts).

    key    <prefix>:<userId>:<sessionId>
    value  JSON {"userId", "sessionId", "userMessages", "modelMessages", "messages",
                 "createdAt", "updatedAt" (epoch ms), "title"?}
    index  SEARCH.CREATE <name> EXISTSOK ON JSON PREFIX 1 <prefix>: SCHEMA
           userId TEXT NOTOKENIZE sessionId TEXT NOTOKENIZE userMessages TEXT modelMessages TEXT

`userMessages` / `modelMessages` are the searchable text of each side, extracted the same way as
the TS default extractor; `messages` keeps the raw transcript and is not indexed.
"""

import time
from dataclasses import dataclass
from typing import Any, Literal

from ._search import SearchIndex, dumps, index_name_for
from ._telemetry import add_telemetry
from .memory import _check_id

DEFAULT_PREFIX = "agentkit:chat"


def extract_text(messages: list[dict[str, Any]]) -> dict[str, str]:
    """Split a transcript into searchable user and model text (the TS `defaultExtractText`)."""
    user: list[str] = []
    model: list[str] = []
    for message in messages:
        parts = message.get("parts")
        if isinstance(parts, list):
            text = " ".join(
                p["text"]
                for p in parts
                if isinstance(p, dict)
                and p.get("type") == "text"
                and isinstance(p.get("text"), str)
            ).strip()
        elif isinstance(message.get("content"), str):
            text = message["content"].strip()
        else:
            text = ""
        if not text:
            continue
        if message.get("role") == "user":
            user.append(text)
        elif message.get("role") in ("assistant", "model"):
            model.append(text)
    return {"userMessages": "\n".join(user), "modelMessages": "\n".join(model)}


@dataclass
class ChatSearchHit:
    session_id: str
    score: float
    title: str | None
    updated_at: int
    user_text: str = ""
    model_text: str = ""


class ChatHistory:
    def __init__(
        self,
        redis: Any,
        *,
        prefix: str = DEFAULT_PREFIX,
        index_name: str | None = None,
        ttl_seconds: int | None = None,
        min_score: float = 0,
        enable_telemetry: bool = True,
    ):
        self.redis = redis
        self.prefix = prefix
        self.ttl_seconds = ttl_seconds
        self.min_score = min_score
        self.index = SearchIndex(
            redis,
            name=index_name or index_name_for(prefix),
            prefix=f"{prefix}:",
            schema=[
                ("userId", "TEXT", True),
                ("sessionId", "TEXT", True),
                ("userMessages", "TEXT", False),
                ("modelMessages", "TEXT", False),
            ],
        )
        add_telemetry(redis, enabled=enable_telemetry)

    def _key(self, user_id: str, session_id: str) -> str:
        return f"{self.prefix}:{user_id}:{session_id}"

    def get_chat(self, session_id: str, *, user_id: str) -> dict[str, Any] | None:
        _check_id(user_id, "user_id")
        _check_id(session_id, "session_id")
        found = self.redis.execute(["JSON.GET", self._key(user_id, session_id), "$"])
        return found[0] if isinstance(found, list) and found else None

    def save_chat(
        self,
        session_id: str,
        messages: list[dict[str, Any]],
        *,
        user_id: str,
        title: str | None = None,
    ) -> dict[str, Any]:
        """Write the whole transcript of a session, keeping `createdAt` (and `title`) of a prior save."""
        existing = self.get_chat(session_id, user_id=user_id) or {}
        now = int(time.time() * 1000)
        doc: dict[str, Any] = {
            "userId": user_id,
            "sessionId": session_id,
            **extract_text(messages),
            "messages": messages,
            "createdAt": existing.get("createdAt") or now,
            "updatedAt": now,
        }
        title = title or existing.get("title")
        if title:
            doc["title"] = title
        key = self._key(user_id, session_id)
        self.redis.execute(["JSON.SET", key, "$", dumps(doc)])
        if self.ttl_seconds:
            self.redis.expire(key, self.ttl_seconds)
        return doc

    def list_chats(self, *, user_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        """Chats of a user, most recently updated first."""
        _check_id(user_id, "user_id")
        rows = self.index.query({"userId": {"$eq": user_id}}, limit=limit)
        docs = [row.data for row in rows if isinstance(row.data, dict)]
        return sorted(docs, key=lambda d: d.get("updatedAt") or 0, reverse=True)

    def search_chats(
        self,
        query: str,
        *,
        user_id: str,
        target: Literal["user", "model", "both"] = "both",
        limit: int | None = None,
    ) -> list[ChatSearchHit]:
        _check_id(user_id, "user_id")
        if target == "both":
            text: dict[str, Any] = {
                "$or": [{"userMessages": {"$smart": query}}, {"modelMessages": {"$smart": query}}]
            }
        else:
            text = {f"{target}Messages": {"$smart": query}}
        rows = self.index.query({"$and": [{"userId": {"$eq": user_id}}, text]}, limit=limit)
        hits = []
        for row in rows:
            data = row.data if isinstance(row.data, dict) else {}
            if row.score < self.min_score:
                continue
            hits.append(
                ChatSearchHit(
                    session_id=data.get("sessionId") or row.key.rsplit(":", 1)[-1],
                    score=row.score,
                    title=data.get("title"),
                    updated_at=data.get("updatedAt") or 0,
                    user_text=data.get("userMessages") or "",
                    model_text=data.get("modelMessages") or "",
                )
            )
        return hits

    def delete_chat(self, session_id: str, *, user_id: str) -> bool:
        _check_id(user_id, "user_id")
        _check_id(session_id, "session_id")
        return bool(self.redis.delete(self._key(user_id, session_id)))
