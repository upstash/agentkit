"""upstash_chat_search passages and upstash_chat_read pages, against a small fake Redis."""

import json
from dataclasses import dataclass
from typing import Any

import pytest
from upstash_hermes_memory import UpstashMemoryProvider
from upstash_hermes_memory import provider as provider_module

# 2026-11-11T09:00:00Z: `createdAt` (ms) of the chats below, and the first turn's `ts` (s).
NOV_11_MS = 1_794_387_600_000
NOV_11_S = NOV_11_MS // 1000


@dataclass
class Row:
    key: str
    score: float
    data: dict[str, Any]


def _user_of(filter: Any) -> str | None:
    """The `userId` a query filters on, wherever it is nested."""
    if isinstance(filter, dict):
        if "userId" in filter:
            return filter["userId"]["$eq"]
        filter = list(filter.values())
    if isinstance(filter, list):
        return next((u for u in map(_user_of, filter) if u), None)
    return None


class FakeRedis:
    """Chat documents by key; a search returns every chat of the user it filters on."""

    def __init__(self):
        self.docs: dict[str, dict[str, Any]] = {}
        self.commands: list[list[Any]] = []

    def execute(self, command):
        self.commands.append(command)
        op = command[0]
        if op == "JSON.GET":
            doc = self.docs.get(command[1])
            return [doc] if doc is not None else None
        if op == "JSON.SET":
            self.docs[command[1]] = json.loads(command[3])
            return "OK"
        if op == "SEARCH.QUERY":
            user = _user_of(json.loads(command[2]))
            limit = int(command[command.index("LIMIT") + 1])
            rows = [Row(k, 1.0, d) for k, d in self.docs.items() if d.get("userId") == user]
            return rows[:limit]
        if op == "SEARCH.COUNT":
            return len(self.docs)
        return 1

    def expire(self, key, seconds):
        return True

    def delete(self, key):
        return int(self.docs.pop(key, None) is not None)


@pytest.fixture
def chat_provider(monkeypatch):
    env = {"UPSTASH_HERMES_USER_ID": "u1"}
    monkeypatch.setattr(provider_module, "get_secret", lambda n, d=None: env.get(n, d))
    redis = FakeRedis()
    provider = UpstashMemoryProvider(redis)
    provider.initialize("s1", platform="cli")
    return provider, redis


def _save(redis, session, messages, user="u1"):
    redis.docs[f"agentkit:chat:{user}:{session}"] = {
        "kind": "chat",
        "userId": user,
        "sessionId": session,
        "userMessages": "\n".join(m["content"] for m in messages if m["role"] == "user"),
        "modelMessages": "\n".join(m["content"] for m in messages if m["role"] == "assistant"),
        "messages": messages,
        "createdAt": NOV_11_MS,
        "updatedAt": NOV_11_MS,
    }


def _session(*turns, start=NOV_11_S):
    """A saved transcript: user turns carry `ts` (a minute apart), replies don't."""
    out = []
    for n, (user, reply) in enumerate(turns):
        out += [
            {"role": "user", "content": user, "ts": start + 60 * n},
            {"role": "assistant", "content": reply},
        ]
    return out


def _call(provider, tool, **args):
    return json.loads(provider.handle_tool_call(tool, args))


# -- upstash_chat_search -------------------------------------------------------------------------


def test_chat_search_shows_the_passage_that_matched_not_the_session_start(chat_provider):
    provider, redis = chat_provider
    _save(
        redis,
        "s-trip",
        _session(
            ("good morning", "morning! what's on today?"),
            ("review the deploy checklist", "done, two items left"),
            ("book the Lisbon flights for May", "booked TAP, leaving May 3"),
            ("thanks", "anytime"),
        ),
    )
    (session,) = _call(provider, "upstash_chat_search", query="Lisbon flights")["sessions"]
    assert session["session_id"] == "s-trip"
    assert session["date"] == "2026-11-11"
    assert [(p["index"], p["role"], p.get("match", False)) for p in session["passage"]] == [
        (3, "assistant", False),
        (4, "user", True),
        (5, "assistant", False),
    ]
    assert session["passage"][1]["text"] == "book the Lisbon flights for May"
    # A reply carries its user message's turn time.
    assert [p["time"] for p in session["passage"]] == [
        "2026-11-11T09:01Z",
        "2026-11-11T09:02Z",
        "2026-11-11T09:02Z",
    ]
    assert "user_excerpt" not in session


def test_a_rarer_query_word_picks_the_message(chat_provider):
    provider, redis = chat_provider
    _save(
        redis,
        "s",
        _session(("the plan for the week", "the plan is set"), ("the Kyoto hotel", "the hotel")),
    )
    (session,) = _call(provider, "upstash_chat_search", query="the Kyoto plan")["sessions"]
    (best,) = [p for p in session["passage"] if p.get("match")]
    assert best["text"] == "the Kyoto hotel"


def test_a_long_message_is_clipped_around_the_match(chat_provider):
    provider, redis = chat_provider
    long = "filler " * 500 + "the invoice number is INV-4471 " + "filler " * 500
    _save(redis, "s", _session((long, "noted")))
    (session,) = _call(provider, "upstash_chat_search", query="invoice")["sessions"]
    best = session["passage"][0]
    assert best["match"] and len(best["text"]) <= 600
    assert best["text"].startswith("…") and best["text"].endswith("…")
    assert "the invoice number is INV-4471" in best["text"]
    assert len(session["passage"][1]["text"]) <= 200  # a neighbour gets less room


def test_without_a_query_word_in_any_message_the_passage_is_the_start(chat_provider):
    provider, redis = chat_provider
    # Search matched fuzzily ("colour" for "color"); no message has the literal word.
    _save(redis, "s", _session(("pick a colour", "teal"), ("and a font", "Inter")))
    (session,) = _call(provider, "upstash_chat_search", query="color")["sessions"]
    assert [(p["index"], p["text"]) for p in session["passage"]] == [
        (0, "pick a colour"),
        (1, "teal"),
    ]
    assert not any(p.get("match") for p in session["passage"])


def test_a_chat_without_messages_falls_back_to_each_side_around_the_match(chat_provider):
    provider, redis = chat_provider
    _save(redis, "s", [])
    redis.docs["agentkit:chat:u1:s"].update(
        {"userMessages": "x " * 400 + "Lisbon in May", "modelMessages": "sure"}
    )
    (session,) = _call(provider, "upstash_chat_search", query="Lisbon")["sessions"]
    user, model = session["passage"]
    assert user["role"] == "user" and "Lisbon in May" in user["text"] and len(user["text"]) <= 300
    assert model == {"role": "assistant", "text": "sure"}


# -- upstash_chat_read ---------------------------------------------------------------------------


def _numbered(redis, count, session="s-long", user="u1"):
    _save(redis, session, _session(*[(f"q{n}", f"a{n}") for n in range(count // 2)]), user=user)


def test_chat_read_pages_through_a_session(chat_provider):
    provider, redis = chat_provider
    _numbered(redis, 30)
    first = _call(provider, "upstash_chat_read", session_id="s-long")
    assert [m["index"] for m in first["messages"]] == list(range(10))
    assert first["next_offset"] == 10 and first["total_messages"] == 30
    assert first["date"] == "2026-11-11"
    assert first["messages"][:2] == [
        {"index": 0, "role": "user", "text": "q0", "time": "2026-11-11T09:00Z"},
        {"index": 1, "role": "assistant", "text": "a0", "time": "2026-11-11T09:00Z"},
    ]
    second = _call(provider, "upstash_chat_read", session_id="s-long", offset=25)
    assert [m["index"] for m in second["messages"]] == list(range(25, 30))
    assert "next_offset" not in second


def test_chat_read_centres_on_a_search_index(chat_provider):
    provider, redis = chat_provider
    _numbered(redis, 30)
    page = _call(provider, "upstash_chat_read", session_id="s-long", around=20, limit=4)
    assert [m["index"] for m in page["messages"]] == [18, 19, 20, 21]
    edge = _call(provider, "upstash_chat_read", session_id="s-long", around=1, limit=4)
    assert [m["index"] for m in edge["messages"]] == [0, 1, 2, 3]


def test_chat_read_clamps_its_limit(chat_provider):
    provider, redis = chat_provider
    _numbered(redis, 100)
    page = _call(provider, "upstash_chat_read", session_id="s-long", limit=1000)
    assert len(page["messages"]) == 40 and page["next_offset"] == 40
    one = _call(provider, "upstash_chat_read", session_id="s-long", limit=0)
    assert len(one["messages"]) == 1


def test_chat_read_caps_each_message_and_the_page(chat_provider):
    provider, redis = chat_provider
    _save(redis, "s-big", _session(*[("u" * 3000, "a" * 3000)] * 5))
    page = _call(provider, "upstash_chat_read", session_id="s-big")
    texts = [m["text"] for m in page["messages"]]
    assert all(len(t) <= 2000 for t in texts) and texts[0].endswith("…")
    assert sum(map(len, texts)) <= 8000
    assert page["next_offset"] == len(texts) == 4


def test_chat_read_only_opens_this_users_sessions(chat_provider):
    provider, redis = chat_provider
    _numbered(redis, 4, session="theirs", user="u2")
    assert "error" in _call(provider, "upstash_chat_read", session_id="theirs")
    assert "error" in _call(provider, "upstash_chat_read", session_id="u2:theirs")
    assert "error" in _call(provider, "upstash_chat_read", session_id="")
    # Search is scoped the same way.
    assert _call(provider, "upstash_chat_search", query="q0")["sessions"] == []
