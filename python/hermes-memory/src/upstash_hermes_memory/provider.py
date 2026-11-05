"""The Hermes Agent memory provider: long-term memory and searchable chat history on Upstash Redis.

Enable it with `memory.provider: upstash` in Hermes's config.yaml. Hermes finds it through the
`hermes_agent.memory_providers` entry point this package declares.

What it does inside Hermes:
- Before each turn, recalls the memories closest to the user's message into the prompt.
- After each turn, saves the session's transcript as a searchable ChatHistory document.
- Mirrors the built-in `memory` tool (adds, corrections and removals), so Redis holds the same
  facts.
- Gives the model four tools: upstash_memory_save / _search / _forget and upstash_chat_search.

Configuration (environment, or Hermes's `$HERMES_HOME/.env`):
- UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (required)
- UPSTASH_HERMES_USER_ID: whose memories these are. Defaults to the gateway user, then the Hermes
  profile name, then "default".
- UPSTASH_HERMES_NAMESPACE: key namespace, default `agentkit`. Memories live at
  `<namespace>:memory:…` (the TS SDK's default keys, so they are shared with AgentKit apps on the
  same database) and chats at `<namespace>:chat:…`, both in one search index, so the provider
  works on Upstash's Free plan (one index per database).
- UPSTASH_HERMES_TELEMETRY: set to `1` to send telemetry (off by default, as the plugin catalog
  requires). `UPSTASH_DISABLE_TELEMETRY` still turns it off.
"""

import hashlib
import json
import logging
import os
import threading
from datetime import datetime
from typing import Any

from ._search import DEFAULT_NAMESPACE
from ._telemetry import OPT_IN_ENV, OPT_OUT_ENV, is_opt_in
from .chat_history import ChatHistory
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
# Built-in memory tool actions Hermes forwards (a patch arrives as a replace).
_MIRRORED_ACTIONS = {"add", "replace", "remove"}


def _mirror_id(target: str, text: str) -> str:
    """The id of a built-in memory entry's mirror: one key per entry, so repeated adds of the
    same entry overwrite it and a replace or remove can delete it without searching."""
    digest = hashlib.sha256(f"{target}\n{text.strip()}".encode()).hexdigest()[:32]
    return f"hermes-{digest}"


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


def _key_part(value: str, what: str) -> str:
    """Check a user or session id for the middle of a `<prefix>:<user>:<id>` key.

    Ids are used as they are, so they match the keys the TS SDK writes for the same id (`team%ops`
    included). `:` separates the parts of the key and the TS SDK refuses it, so it is refused here
    too: any encoding of it could equal another, literal TS id and share that id's memories.
    """
    if ":" in value:
        raise ValueError(f"{what} may not contain ':' (it is the key separator), got {value!r}")
    return value


def _message_text(message: dict[str, Any]) -> str:
    """A message's text the way Hermes flattens it for `sync_turn` (text parts, image count)."""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    texts, images = [], 0
    for part in content:
        if isinstance(part, str):
            texts.append(part)
        elif isinstance(part, dict):
            kind = str(part.get("type") or "").lower()
            if kind in ("text", "input_text", "output_text") and isinstance(part.get("text"), str):
                texts.append(part["text"])
            elif kind in ("image_url", "input_image"):
                images += 1
    text = "\n".join(t for t in texts if t).strip()
    if images:
        note = f"[{images} image{'s' if images != 1 else ''}]"
        text = f"{note} {text}" if text else note
    return text


def _turns_of(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """(user text, reply text) for each user message; the reply is the turn's last assistant text."""
    turns: list[tuple[str, str]] = []
    for message in messages:
        role = message.get("role")
        if role == "user":
            turns.append((_message_text(message), ""))
        elif role == "assistant" and turns:
            text = _message_text(message)
            if text:
                turns[-1] = (turns[-1][0], text)
    return turns


def _epoch(value: Any) -> float | None:
    """A Hermes message timestamp (epoch seconds, or an ISO string) as epoch seconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).timestamp()
        except ValueError:
            return None
    return None


def _cut_by_time(transcript: list[dict[str, Any]], history: list[dict[str, Any]]):
    """The `/undo` cut by timestamp, or None when the timestamps to do it are missing.

    Hermes stamps every message when it enters the conversation, and each saved turn carries its
    user message's stamp (`ts`). Every turn up to the latest user message Hermes still has stays;
    a later one was undone. Identical turns ("yes" / "okay" twice) are told apart, and compaction
    cannot cut anything older.
    """
    stamps = [_epoch(m.get("timestamp")) for m in history if m.get("role") == "user"]
    stamps = [s for s in stamps if s is not None]
    users = [e for e in transcript if e.get("role") == "user"]
    if not stamps or not users or any(not isinstance(e.get("ts"), float) for e in users):
        return None
    cutoff = max(stamps)
    kept, keep = [], False
    for entry in transcript:
        if entry.get("role") == "user":
            keep = entry["ts"] <= cutoff
        if keep:
            kept.append(entry)
    return kept


def rewind_transcript(
    transcript: list[dict[str, Any]], history: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Cut a saved transcript back to what Hermes still has after `/undo`.

    By timestamp when every saved turn and Hermes's history carry one (see `_cut_by_time`).
    Otherwise (turns saved by an older version, or a history without stamps) by content:

    `history` is Hermes's conversation for the session after the undo. Hermes does not say how
    many turns were undone, so the transcript keeps everything up to the latest saved turn
    matching the latest turn still in `history`, and drops the rest. When no turn of the
    transcript is left, every saved turn was undone.

    In-place compaction keeps the session id but summarizes older messages, so `history` can be
    much shorter than the transcript, and counting occurrences across the two would land on an
    older turn. A turn is matched by its user text and its reply instead, and the latest match
    wins, so a repeated "yes" lands on the right turn and retained history is never cut.
    """
    by_time = _cut_by_time(transcript, history)
    if by_time is not None:
        return by_time
    saved: list[tuple[int, str, str]] = []
    for i, entry in enumerate(transcript):
        if entry.get("role") != "user":
            continue
        reply = transcript[i + 1] if i + 1 < len(transcript) else {}
        answer = str(reply.get("content", "")).strip() if reply.get("role") == "assistant" else ""
        saved.append((i, str(entry.get("content", "")).strip(), answer))
    # Walk back past turns that were never saved, such as a compaction summary.
    for user, reply in reversed([t for t in _turns_of(history) if t[0]]):
        same_user = [s for s in saved if s[1] == user]
        matches = [s for s in same_user if s[2] == reply] if reply else same_user
        if not matches:
            continue
        i = matches[-1][0]
        end = i + 1
        if end < len(transcript) and transcript[end].get("role") == "assistant":
            end += 1
        return transcript[:end]
    return []


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
        # Sessions Hermes rewound (/undo): their transcript is cut back on the next sync.
        self._rewound: set[str] = set()
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
        # Hermes logs a failed initialize and keeps the provider, so a refused identity must
        # leave it inactive (no stores: nothing read, nothing written), never on a fallback user.
        self._memory = self._chats = None
        self._write_enabled = False
        user = (
            get_secret("UPSTASH_HERMES_USER_ID", "")
            or kwargs.get("user_id")
            or kwargs.get("agent_identity")
            or "default"
        )
        try:
            user_id = _key_part(str(user), "user id")
        except ValueError as error:
            logger.warning("upstash memory is off for this session: %s", error)
            return
        # Telemetry is opt-in (plugin catalog rule 13), for upstash-redis's own headers as well as
        # ours, so the client is created with allow_telemetry off unless the user asked for it.
        telemetry = is_opt_in(get_secret(OPT_IN_ENV, "")) and not get_secret(OPT_OUT_ENV, "")
        if self._redis is None:
            from upstash_redis import Redis

            self._redis = Redis(
                url=get_secret("UPSTASH_REDIS_REST_URL", ""),
                token=get_secret("UPSTASH_REDIS_REST_TOKEN", ""),
                allow_telemetry=telemetry,
            )
        # Like the credentials, the namespace is read per Hermes profile: a multiplexed gateway
        # keeps each profile's .env out of os.environ. Memory and chats share its one index.
        namespace = get_secret("UPSTASH_HERMES_NAMESPACE", "") or DEFAULT_NAMESPACE
        self._memory = AgentMemory(self._redis, namespace=namespace, enable_telemetry=telemetry)
        self._chats = ChatHistory(self._redis, namespace=namespace, enable_telemetry=telemetry)
        self._user_id = user_id
        self._session_id = self._session_key(session_id)
        self._write_enabled = (kwargs.get("agent_context") or "") in _WRITING_CONTEXTS

    def system_prompt_block(self) -> str:
        if not self._memory:
            return ""
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
        sid = self._session_key(session_id) if session_id else self._session_id
        if not sid:
            return
        with self._lock:
            transcript = self._load_transcript(sid)
            if sid in self._rewound and messages is not None:
                # `messages` ends with this turn, which Hermes appended after the undo.
                history = list(messages)
                while history and history[-1].get("role") != "user":
                    history.pop()
                transcript[:] = rewind_transcript(transcript, history[:-1])
                self._rewound.discard(sid)
            if user_content:
                entry: dict[str, Any] = {"role": "user", "content": user_content}
                # The turn's own stamp, so /undo can cut by time (see `_cut_by_time`).
                stamp = next(
                    (
                        _epoch(m.get("timestamp"))
                        for m in reversed(messages or [])
                        if m.get("role") == "user"
                    ),
                    None,
                )
                if stamp is not None:
                    entry["ts"] = stamp
                transcript.append(entry)
            if assistant_content:
                transcript.append({"role": "assistant", "content": assistant_content})
            self._save_transcript(sid, transcript)

    def on_session_switch(
        self, new_session_id: str, *, rewound: bool = False, **kwargs: Any
    ) -> None:
        self._session_id = self._session_key(new_session_id)
        if rewound:
            # /undo keeps the session id but truncates Hermes's history. The next sync (or the
            # session end) cuts the saved transcript back to match, before anything is appended.
            with self._lock:
                self._rewound.add(self._session_id)

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        """A rewind that no later turn followed still has to drop the undone turns from Redis."""
        sid = self._session_id
        if not self._chats or not self._write_enabled or sid not in self._rewound:
            return
        with self._lock:
            transcript = self._load_transcript(sid)
            transcript[:] = rewind_transcript(transcript, list(messages or []))
            self._rewound.discard(sid)
            self._save_transcript(sid, transcript)

    @staticmethod
    def _session_key(session_id: str | None) -> str:
        """The session id for transcript keys, or "" (no transcript) when it can't be one."""
        try:
            return _key_part(session_id or "", "session id")
        except ValueError as error:
            logger.warning("upstash chat history skipped: %s", error)
            return ""

    def _load_transcript(self, sid: str) -> list[dict[str, str]]:
        transcript = self._transcripts.get(sid)
        if transcript is None:
            assert self._chats is not None
            existing = self._chats.get_chat(sid, user_id=self._user_id) or {}
            transcript = list(existing.get("messages") or [])
            self._transcripts[sid] = transcript
        return transcript

    def _save_transcript(self, sid: str, transcript: list[dict[str, str]]) -> None:
        assert self._chats is not None
        try:
            # Create the index before the first write rather than leaving it to the first
            # search, so no transcript depends on the index's initial backfill.
            self._chats.index.ensure()
            self._chats.save_chat(sid, transcript, user_id=self._user_id)
        except Exception as error:  # noqa: BLE001 - a Redis outage must never break a turn
            logger.warning("upstash chat history save failed: %s", error)

    def on_memory_write(
        self, action: str, target: str, content: str, metadata: dict[str, Any] | None = None
    ) -> None:
        """Mirror built-in `memory` tool writes, so Redis holds the same facts Hermes does.

        Hermes sends `add`, `replace` and `remove` (a patch arrives as a replace whose `content` is
        the whole edited entry). For replace and remove, `metadata["previous_content"]` is the full
        entry before the write: the copy mirrored from it is deleted, and a replace then saves
        `content` in its place, so a corrected or deleted fact is no longer recalled.
        """
        if action not in _MIRRORED_ACTIONS or not self._memory or not self._write_enabled:
            return
        try:
            if action in ("replace", "remove"):
                self._forget_mirrored(target, metadata or {})
            if action in ("add", "replace") and content:
                self._remember(
                    content,
                    {"source": "hermes", "target": target},
                    id=_mirror_id(target, content),
                )
        except Exception as error:  # noqa: BLE001 - as above
            logger.warning("upstash memory mirror failed: %s", error)

    def _forget_mirrored(self, target: str, metadata: dict[str, Any]) -> None:
        """Delete every mirrored copy of the entry a replace or remove changed.

        `previous_content` (the full old entry) is matched exactly. Older Hermes versions only send
        `old_text`, a substring of the entry, so it is used only when exactly one mirrored entry
        contains it. A substring is not a search term ("ordinarycomp" does not match
        "extraordinarycompany" in full-text search), so that path checks every memory of the user.
        Memories saved with upstash_memory_save are never touched.
        """
        assert self._memory is not None
        previous = str(metadata.get("previous_content") or "").strip()
        old_text = str(metadata.get("old_text") or "").strip()
        if not previous and not old_text:
            return
        found = self._all_matches(previous) if previous else self._all_memories()
        candidates = [
            r
            for r in found
            if r.metadata.get("source") == "hermes" and r.metadata.get("target") == target
        ]
        if previous:
            # The stable id finds the mirror even when it ranks low; copies mirrored before ids
            # were stable (0.1.x) have random ids, so every exact match goes too.
            stale_ids = {_mirror_id(target, previous)}
            stale_ids.update(r.id for r in candidates if r.text.strip() == previous)
        else:
            stale_ids = {r.id for r in candidates if old_text in r.text}
            if len(stale_ids) != 1:
                return
        for id in stale_ids:
            self._memory.forget(id, user_id=self._user_id)
        self._memory.index.wait_indexing()

    def _all_matches(self, query: str) -> list[MemoryRecord]:
        """Every memory of this user matching `query`, not just the best few."""
        assert self._memory is not None
        total = self._memory.index.count(
            {**self._memory._filter(self._user_id), "text": {"$smart": query}}
        )
        if total <= 0:
            return []
        return self._memory.recall(query, user_id=self._user_id, top_k=total)

    def _all_memories(self) -> list[MemoryRecord]:
        """Every memory of this user, for the substring match that search can't do."""
        assert self._memory is not None
        total = self._memory.count(user_id=self._user_id)
        if total <= 0:
            return []
        return self._memory.list(user_id=self._user_id, limit=total)

    def _remember(
        self, text: str, metadata: dict[str, Any], *, id: str | None = None
    ) -> MemoryRecord:
        """Save a fact so that it is searchable once this returns.

        Recall reads Redis Search, which indexes a write shortly after it lands. Waiting here
        means a fact saved in one turn is recalled in the next one, or in a session started right
        after. The index is created first, so the write is indexed as a write, not by a backfill.
        """
        assert self._memory is not None
        self._memory.index.ensure()
        record = self._memory.add(text, user_id=self._user_id, id=id, metadata=metadata)
        self._memory.index.wait_indexing()
        return record

    def shutdown(self) -> None:
        self._transcripts.clear()
        self._rewound.clear()

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
