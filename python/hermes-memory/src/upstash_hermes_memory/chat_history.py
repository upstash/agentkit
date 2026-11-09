"""Python port of `ChatHistory` from `@upstash/agentkit-sdk` (packages/sdk/src/chat-history.ts).

    key    <namespace>:chat:<userId>:<sessionId>
    value  JSON {"kind": "chat", "userId", "sessionId", "userMessages", "modelMessages",
                 "messages", "createdAt", "updatedAt" (epoch ms), "title"?}
    index  the namespace's shared index, with AgentMemory (see `_search.SHARED_SCHEMA`)

Passing `prefix` (or `index_name`) gives the store its own index over `<prefix>:` instead, with
the documents written without `kind`, as before.

`userMessages` / `modelMessages` are the searchable text of each side, extracted the same way as
the TS default extractor; `messages` keeps the raw transcript and is not indexed.
"""

import time
from dataclasses import dataclass
from typing import Any, Literal

from ._search import DEFAULT_NAMESPACE, SearchIndex, dumps, index_name_for, shared_index
from ._telemetry import add_telemetry
from .memory import _check_id

DEFAULT_PREFIX = f"{DEFAULT_NAMESPACE}:chat"

# Appends messages to an existing chat in place, in one atomic step, so a long session costs one
# turn's worth of bytes per write instead of the whole transcript (twice: the raw messages plus the
# extracted search text). Returns 0 without writing when the chat does not exist (or has no
# `messages` array), so the caller falls back to a full save.
# ARGV: updatedAt, then for userMessages and modelMessages each the new text as a JSON string
# alone and with a leading "\n" (empty when that side has no text), then one JSON value per message.
# The text is encoded by the caller, as `JSON.stringify` would, never by cjson in the script.
_APPEND_SCRIPT = """#!lua flags=allow-key-locking
local key = KEYS[1]
if redis.call('EXISTS', key) == 0 then return 0 end
local kind = redis.call('JSON.TYPE', key, '$.messages')
if type(kind) ~= 'table' or kind[1] ~= 'array' then return 0 end
local function add_text(path, alone, joined)
  if alone == '' then return end
  local len = redis.call('JSON.STRLEN', key, path)
  if type(len) == 'table' and type(len[1]) == 'number' then
    if len[1] > 0 then
      redis.call('JSON.STRAPPEND', key, path, joined)
    else
      redis.call('JSON.STRAPPEND', key, path, alone)
    end
  else
    redis.call('JSON.SET', key, path, alone)
  end
end
add_text('$.userMessages', ARGV[2], ARGV[3])
add_text('$.modelMessages', ARGV[4], ARGV[5])
if #ARGV > 5 then
  redis.call('JSON.ARRAPPEND', key, '$.messages', unpack(ARGV, 6))
end
redis.call('JSON.SET', key, '$.updatedAt', ARGV[1])
return 1
"""


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
        namespace: str = DEFAULT_NAMESPACE,
        prefix: str | None = None,
        index_name: str | None = None,
        ttl_seconds: int | None = None,
        min_score: float = 0,
        semantic: bool = False,
        enable_telemetry: bool = False,
    ):
        """`semantic` only matters on the shared index: it decides whether a new index gets the
        memory `text` field as HYBRID, so memory and chats create it the same way. Chat search
        itself stays keyword search ($smart)."""
        self.redis = redis
        self.ttl_seconds = ttl_seconds
        self.min_score = min_score
        if prefix is None and index_name is None:
            self.prefix = f"{namespace}:chat"
            self.kind: str | None = "chat"
            self.index = shared_index(redis, namespace, semantic=semantic)
        else:
            self.prefix = prefix or DEFAULT_PREFIX
            self.kind = None
            self.index = SearchIndex(
                redis,
                name=index_name or index_name_for(self.prefix),
                prefix=f"{self.prefix}:",
                schema=[
                    ("userId", "TEXT", True),
                    ("sessionId", "TEXT", True),
                    ("userMessages", "TEXT", False),
                    ("modelMessages", "TEXT", False),
                ],
            )
        add_telemetry(redis, enabled=enable_telemetry)

    def _query(self, filter: dict[str, Any], limit: int | None) -> list[Any]:
        """Query with `kind` added on the shared index, so memories never match (as the TS SDK does)."""
        if self.kind:
            filter = {"$and": [{"kind": {"$eq": self.kind}}, filter]}
        return self.index.query(filter, limit=limit)

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
            **({"kind": self.kind} if self.kind else {}),
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
        # Any TTL that was set is applied, 0 included (expire now), as the TS ChatHistory does.
        if self.ttl_seconds is not None:
            self.redis.expire(key, self.ttl_seconds)
        return doc

    def append_messages(
        self, session_id: str, messages: list[dict[str, Any]], *, user_id: str
    ) -> bool:
        """Append messages to a saved chat in place; False (nothing written) if there is none.

        The document ends up exactly as `save_chat` with the whole transcript would leave it, but
        only the new messages and their text travel, so the write does not grow with the session.
        """
        _check_id(user_id, "user_id")
        _check_id(session_id, "session_id")
        text = extract_text(messages)

        def encoded(side: str) -> list[str]:
            return [dumps(text[side]), dumps("\n" + text[side])] if text[side] else ["", ""]

        key = self._key(user_id, session_id)
        appended = self.redis.execute(
            [
                "EVAL",
                _APPEND_SCRIPT,
                "1",
                key,
                str(int(time.time() * 1000)),
                *encoded("userMessages"),
                *encoded("modelMessages"),
                *(dumps(message) for message in messages),
            ]
        )
        if appended != 1:
            return False
        if self.ttl_seconds is not None:
            self.redis.expire(key, self.ttl_seconds)
        return True

    def list_chats(self, *, user_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        """Chats of a user, most recently updated first."""
        _check_id(user_id, "user_id")
        rows = self._query({"userId": {"$eq": user_id}}, limit)
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
        rows = self._query({"$and": [{"userId": {"$eq": user_id}}, text]}, limit)
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
