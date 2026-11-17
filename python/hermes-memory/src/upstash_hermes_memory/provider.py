"""The Hermes Agent memory provider: long-term memory and searchable chat history on Upstash Redis.

Enable it with `memory.provider: upstash` in Hermes's config.yaml. Hermes finds it through the
`hermes_agent.memory_providers` entry point this package declares.

What it does inside Hermes:
- Before each turn, recalls the memories closest to the user's message into the prompt.
- After each turn, saves the session's transcript as a searchable ChatHistory document.
- Mirrors the built-in `memory` tool (adds, corrections and removals), so Redis holds the same
  facts.
- Gives the model five tools: upstash_memory_save / _search / _forget, upstash_chat_search and
  upstash_chat_read.

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
- UPSTASH_HERMES_CHAT_TTL_DAYS: delete a session's transcript this many days after its last turn.
  Unset (or 0) keeps transcripts until they are deleted. Memories never expire.
"""

import hashlib
import json
import logging
import math
import os
import re
import threading
from datetime import UTC, datetime
from typing import Any

from ._search import DEFAULT_NAMESPACE
from ._telemetry import OPT_IN_ENV, OPT_OUT_ENV, is_opt_in
from .chat_history import ChatHistory, ChatSearchHit, message_text
from .memory import SMART_QUERY_CHARS, AgentMemory, MemoryRecord, bound_query

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
# Hybrid search always returns its `LIMIT` (the $ann side has no relevance threshold, and its
# similarity scores do not separate related from unrelated memories well enough for a cutoff), so
# automatic recall injects only a few. The search tool has its own limit.
_PREFETCH_TOP_K = 3
_EXCERPT_CHARS = 300
# Built-in memory tool actions Hermes forwards (a patch arrives as a replace).
_MIRRORED_ACTIONS = {"add", "replace", "remove"}
# Tool limits, so one call can't flood the context or ask Search for thousands of rows. A larger
# `limit` is lowered to the maximum rather than refused.
_SEARCH_DEFAULT, _SEARCH_MAX = 5, 20
_CHAT_SEARCH_DEFAULT, _CHAT_SEARCH_MAX = 5, 10
_READ_DEFAULT, _READ_MAX = 10, 40
# upstash_chat_search shows, per session, the message that matched best (clipped around the
# match) and its neighbours; upstash_chat_read shows whole messages up to a cap per message and
# per page.
_MATCH_CHARS = 600
_NEIGHBOUR_CHARS = 200
_READ_MESSAGE_CHARS = 2000
_READ_PAGE_CHARS = 8000
# A memory is one standalone sentence; a longer text is refused rather than cut.
_SAVE_MAX_CHARS = 1000
CHAT_TTL_ENV = "UPSTASH_HERMES_CHAT_TTL_DAYS"


def _mirror_id(target: str, text: str) -> str:
    """The id of a built-in memory entry's mirror: one key per entry, so repeated adds of the
    same entry overwrite it and a replace or remove can delete it without searching."""
    digest = hashlib.sha256(f"{target}\n{text.strip()}".encode()).hexdigest()[:32]
    return f"hermes-{digest}"


SAVE_SCHEMA = {
    "name": "upstash_memory_save",
    "description": (
        "Save one situational fact to long-term memory, recalled when its topic comes up: a "
        "person, who owns what, project or customer context, a lesson learned, a pointer to "
        "where something is. Facts needed in every session belong in the built-in memory "
        "instead. Write one standalone sentence that says when and where the fact comes from."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": f"The fact, one sentence (at most {_SAVE_MAX_CHARS} characters).",
            }
        },
        "required": ["text"],
    },
}
SEARCH_SCHEMA = {
    "name": "upstash_memory_search",
    "description": (
        "Search long-term memory for facts related to a query. Returns ids, text, the date each "
        "was saved, whether it is a copy of a built-in memory entry (`mirror`), and a score; "
        "scores rank results within one search only (`retrieval` says how they were found)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for."},
            "limit": {
                "type": "integer",
                "description": f"Maximum results (default {_SEARCH_DEFAULT}, at most {_SEARCH_MAX}).",
            },
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
        "with their date and the passage that matched: the best-matching message and its "
        "neighbours, each with its role, index and turn time. Open more of a session with "
        "upstash_chat_read."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to look for."},
            "limit": {
                "type": "integer",
                "description": (
                    f"Maximum sessions (default {_CHAT_SEARCH_DEFAULT}, at most {_CHAT_SEARCH_MAX})."
                ),
            },
        },
        "required": ["query"],
    },
}
CHAT_READ_SCHEMA = {
    "name": "upstash_chat_read",
    "description": (
        "Read part of one past conversation, by a session_id from upstash_chat_search. Returns "
        "up to `limit` messages in order from `offset`, or centred on `around` (a message index "
        "from a search passage), and `next_offset` when the session goes on. Long messages are "
        "shortened."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "The session to read."},
            "around": {"type": "integer", "description": "A message index to centre the page on."},
            "offset": {"type": "integer", "description": "The first message index (default 0)."},
            "limit": {
                "type": "integer",
                "description": f"Maximum messages (default {_READ_DEFAULT}, at most {_READ_MAX}).",
            },
        },
        "required": ["session_id"],
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


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


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
    # Redis hands a whole-number stamp back as an int (`1000.0` is read as `1000`), so any number
    # counts; only a turn without one (saved by an older version) forces the content cut.
    if not stamps or not users or any(not _is_number(e.get("ts")) for e in users):
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


def _recalled_line(record: MemoryRecord) -> str:
    """A recalled memory for the prompt, with the date it was saved: `- [saved 2026-11-11] …`."""
    saved = _date(record.created_at)
    return f"- [saved {saved}] {record.text}" if saved else f"- {record.text}"


def _clamp(value: Any, default: int, maximum: int) -> int:
    """A tool's `limit`: `default` when missing, otherwise between 1 and `maximum`."""
    if value is None or value == "":
        return default
    return max(1, min(int(value), maximum))


def _date(epoch_ms: Any) -> str | None:
    """A stored `createdAt` (epoch ms) as its UTC date, `YYYY-MM-DD`; None when there is none."""
    if not _is_number(epoch_ms) or epoch_ms <= 0:
        return None
    return datetime.fromtimestamp(epoch_ms / 1000, UTC).strftime("%Y-%m-%d")


def _time(epoch_s: Any) -> str | None:
    """A turn's stamp (`ts`, epoch seconds) in UTC to the minute; None when there is none."""
    if not _is_number(epoch_s) or epoch_s <= 0:
        return None
    return datetime.fromtimestamp(epoch_s, UTC).strftime("%Y-%m-%dT%H:%MZ")


def _terms(query: str) -> list[str]:
    """The query's words, lowercased, to find the message a session matched on.

    Search matched the session, fuzzily and with stemming; this only picks the passage to show,
    so plain substring matching is enough ("trip" finds "trips").
    """
    return sorted({word for word in re.findall(r"\w+", query.lower()) if len(word) > 1})


def _best_message(texts: list[str], terms: list[str]) -> int | None:
    """The index of the text matching the query best, or None when no text has a query word.

    A word found in fewer messages counts more, so a common word ("the", the user's name) does
    not outweigh the one the user is looking for. A tie goes to the earlier message.
    """
    lowered = [text.lower() for text in texts]
    found_in = {term: sum(term in text for text in lowered) for term in terms}
    best, best_score = None, 0.0
    for i, text in enumerate(lowered):
        score = sum(1 / found_in[term] for term in terms if found_in[term] and term in text)
        if score > best_score:
            best, best_score = i, score
    return best


def _clip(text: str, terms: list[str], limit: int) -> str:
    """At most `limit` characters of `text`, around its first query word; "…" marks a cut."""
    if len(text) <= limit:
        return text
    lowered = text.lower()
    found = [at for at in (lowered.find(term) for term in terms) if at >= 0]
    room = limit - 2  # one "…" on each side at most
    start = max(0, min((min(found) if found else 0) - room // 3, len(text) - room))
    end = start + room
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def _turn_times(messages: list[dict[str, Any]]) -> list[Any]:
    """Each message's turn stamp: a user message's own `ts`, a reply its user message's."""
    times, current = [], None
    for message in messages:
        if message.get("role") == "user":
            current = message.get("ts")
        times.append(current)
    return times


def _passage(hit: ChatSearchHit, query: str) -> list[dict[str, Any]]:
    """Where in a session the query matched: the best-matching message and its neighbours.

    Falls back to the session's first two messages when no message contains a query word (Search
    matches fuzzily), and to the start of each side's text for a chat saved without `messages`.
    """
    terms = _terms(query)
    if not hit.messages:
        sides = (("user", hit.user_text), ("assistant", hit.model_text))
        return [
            {"role": role, "text": _clip(text, terms, _EXCERPT_CHARS)}
            for role, text in sides
            if text
        ]
    texts = [message_text(m) for m in hit.messages]
    best = _best_message(texts, terms)
    if best is None:
        shown = [i for i, text in enumerate(texts) if text][:2]
    else:
        shown = [i for i in (best - 1, best, best + 1) if 0 <= i < len(texts) and texts[i]]
    times = _turn_times(hit.messages)
    passage = []
    for i in shown:
        entry: dict[str, Any] = {
            "index": i,
            "role": hit.messages[i].get("role"),
            "text": _clip(texts[i], terms, _MATCH_CHARS if i == best else _NEIGHBOUR_CHARS),
        }
        if i == best:
            entry["match"] = True
        if when := _time(times[i]):
            entry["time"] = when
        passage.append(entry)
    return passage


def _chat_ttl_seconds() -> int | None:
    """UPSTASH_HERMES_CHAT_TTL_DAYS in seconds, or None to keep transcripts (unset, 0, invalid)."""
    raw = str(get_secret(CHAT_TTL_ENV, "") or "").strip()
    if not raw:
        return None
    try:
        days = float(raw)
    except ValueError:
        days = math.nan
    if not math.isfinite(days) or days < 0:
        logger.warning(
            "%s must be a number of days, got %r: keeping transcripts", CHAT_TTL_ENV, raw
        )
        return None
    # 0 means no expiry here: ChatHistory would expire a chat at once with a TTL of 0.
    return max(1, round(days * 86400)) if days > 0 else None


class UpstashMemoryProvider(MemoryProvider):
    def __init__(self, redis: Any = None):
        self._redis = redis
        self._memory: AgentMemory | None = None
        self._chats: ChatHistory | None = None
        self._user_id = "default"
        self._session_id = ""
        self._write_enabled = True
        # Sessions Hermes rewound (/undo): their transcript is cut back on the next sync.
        self._rewound: set[str] = set()
        # Chat changes not yet in Redis, per session, in order: ("add", messages) for a turn and
        # ("cut", history) for an /undo. Cleared only once a write succeeds, so a failed write
        # (a network blip) is redone by the next turn instead of being lost.
        self._pending: dict[str, list[tuple[str, list[dict[str, Any]]]]] = {}
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
        self._chats = ChatHistory(
            self._redis,
            namespace=namespace,
            ttl_seconds=_chat_ttl_seconds(),
            enable_telemetry=telemetry,
        )
        self._user_id = user_id
        self._session_id = self._session_key(session_id)
        self._write_enabled = (kwargs.get("agent_context") or "") in _WRITING_CONTEXTS

    def system_prompt_block(self) -> str:
        if not self._memory:
            return ""
        return (
            "# Upstash Memory\n"
            f"Long-term memory is stored in Upstash Redis for user `{self._user_id}`. Memories "
            "related to each message are recalled automatically into <memory-context>, with the "
            "date each was saved. Recalled memories and past conversations are history to verify, "
            "not the current state. Facts needed in every session belong in the built-in memory; "
            "use upstash_memory_save for situational facts that matter when their topic comes up "
            "(people, ownership, project or customer context, lessons, pointers), one standalone "
            "sentence with its date and source. Use upstash_memory_search to look one up, "
            "upstash_memory_forget to delete one, upstash_chat_search to find something said in "
            "an earlier conversation and upstash_chat_read to read more of it."
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
        lines = "\n".join(_recalled_line(hit) for hit in hits)
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
        new: list[dict[str, Any]] = []
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
            new.append(entry)
        if assistant_content:
            new.append({"role": "assistant", "content": assistant_content})
        with self._lock:
            ops = self._pending.setdefault(sid, [])
            if sid in self._rewound and messages is not None:
                # `messages` ends with this turn, which Hermes appended after the undo.
                history = list(messages)
                while history and history[-1].get("role") != "user":
                    history.pop()
                ops.append(("cut", history[:-1]))
                self._rewound.discard(sid)
            if new:
                ops.append(("add", new))
            self._flush(sid)

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
        if not self._chats or not self._write_enabled:
            return
        if sid not in self._rewound:
            # Nothing to cut, but a turn whose write failed still gets one more try.
            with self._lock:
                self._flush(sid)
            return
        with self._lock:
            self._pending.setdefault(sid, []).append(("cut", list(messages or [])))
            self._rewound.discard(sid)
            self._flush(sid)

    @staticmethod
    def _session_key(session_id: str | None) -> str:
        """The session id for transcript keys, or "" (no transcript) when it can't be one."""
        try:
            return _key_part(session_id or "", "session id")
        except ValueError as error:
            logger.warning("upstash chat history skipped: %s", error)
            return ""

    def _load_transcript(self, sid: str) -> list[dict[str, Any]]:
        """The saved transcript, read fresh: only /undo needs it, so it is never cached."""
        assert self._chats is not None
        existing = self._chats.get_chat(sid, user_id=self._user_id) or {}
        return list(existing.get("messages") or [])

    def _flush(self, sid: str) -> None:
        """Write the session's pending changes; they stay pending if the write fails.

        Turns alone are appended in place, so a write stays the size of what is new. An /undo
        cut needs the saved transcript, so then the whole transcript is read, every pending
        change applied in order, and written back.
        """
        assert self._chats is not None
        ops = self._pending.get(sid)
        if not ops:
            self._pending.pop(sid, None)
            return
        try:
            # Create the index before the first write rather than leaving it to the first
            # search, so no transcript depends on the index's initial backfill.
            self._chats.index.ensure()
            if any(kind == "cut" for kind, _ in ops):
                transcript = self._load_transcript(sid)
                for kind, items in ops:
                    transcript = (
                        rewind_transcript(transcript, items)
                        if kind == "cut"
                        else transcript + items
                    )
                self._chats.save_chat(sid, transcript, user_id=self._user_id)
            else:
                added = [m for _, items in ops for m in items]
                if not self._chats.append_messages(sid, added, user_id=self._user_id):
                    # The first turn of a session (or the first that got through) creates it.
                    self._chats.save_chat(sid, added, user_id=self._user_id)
        except Exception as error:  # noqa: BLE001 - a Redis outage must never break a turn
            logger.warning("upstash chat history save failed, retrying next turn: %s", error)
            return
        self._pending.pop(sid, None)

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
        # Recall bounds a long query the same way; COUNT and QUERY must describe the same set.
        smart = bound_query(query, SMART_QUERY_CHARS)
        total = self._memory.index.count(
            {**self._memory._filter(self._user_id), "text": {"$smart": smart}}
        )
        if total <= 0:
            return []
        # Keyword mode: the COUNT above cannot take $ann, and both must describe the same set.
        return self._memory.recall(query, user_id=self._user_id, top_k=total, mode="keyword")

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
        self._rewound.clear()
        self._pending.clear()

    # -- tools ---------------------------------------------------------------------------------

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [SAVE_SCHEMA, SEARCH_SCHEMA, FORGET_SCHEMA, CHAT_SEARCH_SCHEMA, CHAT_READ_SCHEMA]

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
            if len(text) > _SAVE_MAX_CHARS:
                raise ValueError(
                    f"text is {len(text)} characters, the limit is {_SAVE_MAX_CHARS}: save one "
                    "standalone sentence per fact"
                )
            record = self._remember(text, {"source": "hermes"})
            return {"saved": True, "id": record.id}
        if tool_name == "upstash_memory_search":
            hits = self._memory.recall(
                str(args.get("query") or ""),
                user_id=self._user_id,
                top_k=_clamp(args.get("limit"), _SEARCH_DEFAULT, _SEARCH_MAX),
            )
            return {
                "results": [
                    {
                        "id": h.id,
                        "text": h.text,
                        "saved": _date(h.created_at),
                        # A copy of a built-in memory entry (see `on_memory_write`); a memory
                        # saved with upstash_memory_save has no `target`.
                        "mirror": h.metadata.get("source") == "hermes"
                        and bool(h.metadata.get("target")),
                        "score": h.score,
                        "retrieval": h.retrieval,
                    }
                    for h in hits
                ]
            }
        if tool_name == "upstash_memory_forget":
            if not self._write_enabled:
                raise RuntimeError("memory is read-only in this agent context")
            return {
                "forgotten": self._memory.forget(str(args.get("id") or ""), user_id=self._user_id)
            }
        if tool_name == "upstash_chat_search":
            query = str(args.get("query") or "")
            hits = self._chats.search_chats(
                query,
                user_id=self._user_id,
                limit=_clamp(args.get("limit"), _CHAT_SEARCH_DEFAULT, _CHAT_SEARCH_MAX),
            )
            return {
                "sessions": [
                    {
                        "session_id": h.session_id,
                        "date": _date(h.created_at),
                        "score": h.score,
                        "title": h.title,
                        "updated_at": h.updated_at,
                        "passage": _passage(h, query),
                    }
                    for h in hits
                ]
            }
        if tool_name == "upstash_chat_read":
            return self._read_chat(args)
        raise ValueError(f"unknown tool {tool_name}")

    def _read_chat(self, args: dict[str, Any]) -> dict[str, Any]:
        """A page of one of this user's sessions, bounded per message and per page.

        The chat is read by its key, which holds the user id, so another user's session is not
        found, just as search never returns it.
        """
        assert self._chats is not None
        sid = _key_part(str(args.get("session_id") or "").strip(), "session id")
        if not sid:
            raise ValueError("session_id is required")
        doc = self._chats.get_chat(sid, user_id=self._user_id)
        if not doc:
            raise ValueError(f"no saved conversation with session id {sid!r}")
        messages = [m for m in doc.get("messages") or [] if isinstance(m, dict)]
        limit = _clamp(args.get("limit"), _READ_DEFAULT, _READ_MAX)
        if args.get("around") not in (None, ""):
            start = int(args["around"]) - limit // 2
        else:
            start = int(args.get("offset") or 0)
        start = max(0, min(start, len(messages)))
        times = _turn_times(messages)
        page: list[dict[str, Any]] = []
        used, end = 0, start
        for i in range(start, min(start + limit, len(messages))):
            text = message_text(messages[i])
            if len(text) > _READ_MESSAGE_CHARS:
                text = text[: _READ_MESSAGE_CHARS - 1] + "…"
            if page and used + len(text) > _READ_PAGE_CHARS:
                break
            entry: dict[str, Any] = {"index": i, "role": messages[i].get("role"), "text": text}
            if when := _time(times[i]):
                entry["time"] = when
            page.append(entry)
            used += len(text)
            end = i + 1
        result: dict[str, Any] = {
            "session_id": sid,
            "date": _date(doc.get("createdAt")),
            "title": doc.get("title"),
            "total_messages": len(messages),
            "messages": page,
        }
        if end < len(messages):
            result["next_offset"] = end
        return result
