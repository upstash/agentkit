"""The Hermes Agent memory provider: long-term memory and searchable chat history on Upstash Redis.

Enable it with `memory.provider: upstash` in Hermes's config.yaml. Hermes finds it through the
`hermes_agent.memory_providers` entry point this package declares.

What it does inside Hermes:
- Before each turn, recalls the memories closest to the user's message into the prompt.
- After each turn, saves the session's transcript as a searchable ChatHistory document.
- Mirrors facts the built-in `memory` tool adds, so they are searchable in Redis too.
- Gives the model four tools: upstash_memory_save / _search / _forget and upstash_chat_search.

Configuration (environment, or Hermes's `$HERMES_HOME/.env`):
- UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (required)
- UPSTASH_HERMES_USER_ID: whose memories these are. Defaults to the gateway user, then the Hermes
  profile name, then "default".
- UPSTASH_HERMES_MEMORY_PREFIX / UPSTASH_HERMES_CHAT_PREFIX: key prefixes. The defaults are the
  TS SDK's (`agentkit:memory`, `agentkit:chat`), so memories are shared with AgentKit apps that
  use the same database.
"""

import json
import logging
import os
import threading
from typing import Any

from .chat_history import DEFAULT_PREFIX as CHAT_PREFIX
from .chat_history import ChatHistory
from .memory import DEFAULT_PREFIX as MEMORY_PREFIX
from .memory import AgentMemory, MemoryRecord

try:  # Inside Hermes. Outside it (tests, plain library use) the provider is a plain class.
    from agent.memory_provider import MemoryProvider
except ImportError:  # pragma: no cover - depends on the host
    MemoryProvider = object  # type: ignore[assignment,misc]

try:
    from agent.secret_scope import get_secret
except ImportError:  # pragma: no cover - depends on the host

    def get_secret(name: str, default: str | None = None) -> str | None:
        return os.environ.get(name, default)


logger = logging.getLogger(__name__)

# Hermes only lets the primary agent write; subagents, cron jobs and flushes read.
_WRITING_CONTEXTS = {"", "primary"}
_PREFETCH_TOP_K = 5
_EXCERPT_CHARS = 300

SAVE_SCHEMA = {
    "name": "upstash_memory_save",
    "description": (
        "Save one durable fact about the user or their work to long-term memory (preferences, "
        "decisions, people, projects). Write it as a short standalone sentence."
    ),
    "parameters": {
        "type": "object",
        "properties": {"text": {"type": "string", "description": "The fact to remember."}},
        "required": ["text"],
    },
}
SEARCH_SCHEMA = {
    "name": "upstash_memory_search",
    "description": "Search long-term memory for facts related to a query. Returns ids and text.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for."},
            "limit": {"type": "integer", "description": "Maximum results (default 5)."},
        },
        "required": ["query"],
    },
}
FORGET_SCHEMA = {
    "name": "upstash_memory_forget",
    "description": "Delete one memory by the id that upstash_memory_search returned.",
    "parameters": {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "The memory id."}},
        "required": ["id"],
    },
}
CHAT_SEARCH_SCHEMA = {
    "name": "upstash_chat_search",
    "description": (
        "Search the transcripts of past conversations with this user. Returns matching sessions "
        "with an excerpt of each side."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for."},
            "limit": {"type": "integer", "description": "Maximum sessions (default 5)."},
        },
        "required": ["query"],
    },
}


def _safe_id(value: str) -> str:
    """Keys are `<prefix>:<user>:<id>`, so a `:` inside an id would break the layout."""
    return value.replace(":", "_")


class UpstashMemoryProvider(MemoryProvider):
    def __init__(self, redis: Any = None):
        self._redis = redis
        self._memory: AgentMemory | None = None
        self._chats: ChatHistory | None = None
        self._user_id = "default"
        self._session_id = ""
        self._write_enabled = True
        # Transcript per session, loaded from Redis on first use so a resumed session appends.
        self._transcripts: dict[str, list[dict[str, str]]] = {}
        self._lock = threading.Lock()

    # -- identity and setup ------------------------------------------------------------------

    @property
    def name(self) -> str:
        return "upstash"

    def is_available(self) -> bool:
        if self._redis is not None:
            return True
        return bool(
            get_secret("UPSTASH_REDIS_REST_URL", "") and get_secret("UPSTASH_REDIS_REST_TOKEN", "")
        )

    def unavailable_reason(self) -> str:
        return "Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (hermes memory setup)."

    def get_config_schema(self) -> list[dict[str, Any]]:
        return [
            {
                "key": "url",
                "description": "Upstash Redis REST URL",
                "required": True,
                "env_var": "UPSTASH_REDIS_REST_URL",
                "url": "https://console.upstash.com/redis",
            },
            {
                "key": "token",
                "description": "Upstash Redis REST token",
                "secret": True,
                "required": True,
                "env_var": "UPSTASH_REDIS_REST_TOKEN",
            },
            {
                "key": "user_id",
                "description": "Whose memories these are (defaults to the Hermes profile name)",
                "required": False,
                "env_var": "UPSTASH_HERMES_USER_ID",
            },
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        # Every field maps to an env var, which `hermes memory setup` writes to $HERMES_HOME/.env.
        pass

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        if self._redis is None:
            from upstash_redis import Redis

            self._redis = Redis(
                url=get_secret("UPSTASH_REDIS_REST_URL", ""),
                token=get_secret("UPSTASH_REDIS_REST_TOKEN", ""),
            )
        self._memory = AgentMemory(
            self._redis, prefix=os.environ.get("UPSTASH_HERMES_MEMORY_PREFIX") or MEMORY_PREFIX
        )
        self._chats = ChatHistory(
            self._redis, prefix=os.environ.get("UPSTASH_HERMES_CHAT_PREFIX") or CHAT_PREFIX
        )
        user = (
            get_secret("UPSTASH_HERMES_USER_ID", "")
            or kwargs.get("user_id")
            or kwargs.get("agent_identity")
            or "default"
        )
        self._user_id = _safe_id(str(user))
        self._session_id = _safe_id(session_id or "")
        self._write_enabled = (kwargs.get("agent_context") or "") in _WRITING_CONTEXTS

    def system_prompt_block(self) -> str:
        return (
            "# Upstash Memory\n"
            f"Long-term memory is stored in Upstash Redis for user `{self._user_id}`. Memories "
            "related to each message are recalled automatically into <memory-context>. Use "
            "upstash_memory_save for durable facts worth keeping across sessions, "
            "upstash_memory_search to look one up, upstash_memory_forget to delete one, and "
            "upstash_chat_search to find something said in an earlier conversation."
        )

    # -- lifecycle -----------------------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._memory or not query.strip():
            return ""
        try:
            hits = self._memory.recall(query, user_id=self._user_id, top_k=_PREFETCH_TOP_K)
        except Exception as error:  # noqa: BLE001 - a Redis outage must never break a turn
            logger.warning("upstash memory recall failed: %s", error)
            return ""
        if not hits:
            return ""
        lines = "\n".join(f"- {hit.text}" for hit in hits)
        return f"## Upstash Memory\n{lines}"

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: list[dict[str, Any]] | None = None,
    ) -> None:
        if not self._chats or not self._write_enabled:
            return
        sid = _safe_id(session_id or self._session_id)
        if not sid:
            return
        with self._lock:
            transcript = self._transcripts.get(sid)
            if transcript is None:
                existing = self._chats.get_chat(sid, user_id=self._user_id) or {}
                transcript = list(existing.get("messages") or [])
                self._transcripts[sid] = transcript
            if user_content:
                transcript.append({"role": "user", "content": user_content})
            if assistant_content:
                transcript.append({"role": "assistant", "content": assistant_content})
            try:
                # Create the index before the first write rather than leaving it to the first
                # search, so no transcript depends on the index's initial backfill.
                self._chats.index.ensure()
                self._chats.save_chat(sid, transcript, user_id=self._user_id)
            except Exception as error:  # noqa: BLE001 - as above
                logger.warning("upstash chat history save failed: %s", error)

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        self._session_id = _safe_id(new_session_id or "")

    def on_memory_write(
        self, action: str, target: str, content: str, metadata: dict[str, Any] | None = None
    ) -> None:
        """Mirror facts the built-in `memory` tool adds, so Redis holds them too."""
        if action != "add" or not content or not self._memory or not self._write_enabled:
            return
        try:
            self._remember(content, {"source": "hermes", "target": target})
        except Exception as error:  # noqa: BLE001 - as above
            logger.warning("upstash memory mirror failed: %s", error)

    def _remember(self, text: str, metadata: dict[str, Any]) -> MemoryRecord:
        """Save a fact so that it is searchable once this returns.

        Recall reads Redis Search, which indexes a write shortly after it lands. Waiting here
        means a fact saved in one turn is recalled in the next one, or in a session started right
        after. The index is created first, so the write is indexed as a write, not by a backfill.
        """
        assert self._memory is not None
        self._memory.index.ensure()
        record = self._memory.add(text, user_id=self._user_id, metadata=metadata)
        self._memory.index.wait_indexing()
        return record

    def shutdown(self) -> None:
        self._transcripts.clear()

    # -- tools ---------------------------------------------------------------------------------

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [SAVE_SCHEMA, SEARCH_SCHEMA, FORGET_SCHEMA, CHAT_SEARCH_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        try:
            return json.dumps(self._call(tool_name, args or {}), ensure_ascii=False)
        except Exception as error:  # noqa: BLE001 - Hermes expects errors as JSON results
            return json.dumps({"error": str(error)})

    def _call(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        if not self._memory or not self._chats:
            raise RuntimeError("upstash memory is not initialized")
        if tool_name == "upstash_memory_save":
            if not self._write_enabled:
                raise RuntimeError("memory is read-only in this agent context")
            text = str(args.get("text") or "").strip()
            if not text:
                raise ValueError("text is required")
            record = self._remember(text, {"source": "hermes"})
            return {"saved": True, "id": record.id}
        if tool_name == "upstash_memory_search":
            hits = self._memory.recall(
                str(args.get("query") or ""),
                user_id=self._user_id,
                top_k=int(args.get("limit") or 5),
            )
            return {"results": [{"id": h.id, "text": h.text, "score": h.score} for h in hits]}
        if tool_name == "upstash_memory_forget":
            if not self._write_enabled:
                raise RuntimeError("memory is read-only in this agent context")
            return {
                "forgotten": self._memory.forget(str(args.get("id") or ""), user_id=self._user_id)
            }
        if tool_name == "upstash_chat_search":
            hits = self._chats.search_chats(
                str(args.get("query") or ""),
                user_id=self._user_id,
                limit=int(args.get("limit") or 5),
            )
            return {
                "sessions": [
                    {
                        "session_id": h.session_id,
                        "score": h.score,
                        "title": h.title,
                        "updated_at": h.updated_at,
                        "user_excerpt": h.user_text[:_EXCERPT_CHARS],
                        "assistant_excerpt": h.model_text[:_EXCERPT_CHARS],
                    }
                    for h in hits
                ]
            }
        raise ValueError(f"unknown tool {tool_name}")
