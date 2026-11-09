"""Semantic (hybrid) recall, against a scripted fake Redis."""

import json
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from upstash_hermes_memory import AgentMemory, ChatHistory, UpstashMemoryProvider
from upstash_hermes_memory import provider as provider_module
from upstash_hermes_memory._search import SHARED_SCHEMA, shared_index
from upstash_redis.errors import UpstashError

MISMATCH = "ERR Index agentkit already exists with a different configuration"
HYBRID = SHARED_SCHEMA
OLD_TEXT_INDEX = [(f, "TEXT", nt) for f, _, nt in SHARED_SCHEMA]
USER = {"userId": {"$eq": "u1"}, "$mustNot": [{"kind": {"$eq": "chat"}}]}


@dataclass
class Row:
    key: str
    score: float
    data: dict[str, Any]


def memory_row(id, text="x", score=1.0):
    return Row(f"agentkit:memory:u1:{id}", score, {"text": text, "userId": "u1", "createdAt": 1})


class FakeRedis:
    """A small model of Upstash Redis Search, enough for the index lifecycle and recall.

    Memory rows and a chat count are the index contents. Every command is recorded.
    """

    def __init__(self, index_schema=None, memories=(), chats=0):
        self.index_schema = list(index_schema) if index_schema else None
        self.memories = list(memories)
        self.chats = chats
        self.hybrid_error: Exception | None = None
        self.keyword_error: Exception | None = None
        self.wait_result: int | None = None
        self.commands: list[list[Any]] = []
        self._headers: dict[str, str] = {}

    def execute(self, command):
        self.commands.append(command)
        op = command[0]
        if op == "SEARCH.CREATE":
            schema = _schema_of(command)
            if self.index_schema is not None and self.index_schema != schema:
                raise UpstashError(MISMATCH)
            self.index_schema = schema
            return 1
        if op == "SEARCH.DROP":
            dropped, self.index_schema = self.index_schema is not None, None
            return int(dropped)
        if op == "SEARCH.WAITINDEXING":
            if self.wait_result is not None:
                return self.wait_result
            return 1 if self.index_schema else 0
        if op == "SEARCH.QUERY":
            if self.index_schema is None:
                return []
            filter = json.loads(command[2])
            error = self.hybrid_error if "$rrf" in filter else self.keyword_error
            if error:
                raise error
            limit = int(command[command.index("LIMIT") + 1]) if "LIMIT" in command else 10
            return self.memories[:limit]
        if op == "SEARCH.COUNT":
            if self.index_schema is None:
                return -1
            filter = json.loads(command[2])
            if {"$rrf", "$ann"} & set(filter):
                raise UpstashError("ERR $ann cannot be used with SEARCH.COUNT")
            if filter == {"kind": {"$eq": "chat"}}:
                return self.chats
            if filter == {}:
                return len(self.memories) + self.chats
            return len(self.memories)
        return 1

    def delete(self, key):
        self.commands.append(["DEL", key])
        return 1

    def expire(self, key, seconds):
        return True

    def ops(self):
        return [c[0] for c in self.commands]

    def queries(self):
        return [json.loads(c[2]) for c in self.commands if c[0] == "SEARCH.QUERY"]


def _schema_of(command):
    i = command.index("SCHEMA") + 1
    out, rest = [], command[i:]
    while rest:
        field, type_ = rest[0], rest[1]
        no_tokenize = len(rest) > 2 and rest[2] == "NOTOKENIZE"
        out.append((field, type_, no_tokenize))
        rest = rest[3:] if no_tokenize else rest[2:]
    return out


# -- index creation ------------------------------------------------------------------------------


def test_text_is_the_only_hybrid_field():
    command = shared_index(FakeRedis(), "agentkit").create_command()
    assert " ".join(command).endswith(
        "SCHEMA kind TEXT NOTOKENIZE userId TEXT NOTOKENIZE text HYBRID sessionId TEXT NOTOKENIZE "
        "userMessages TEXT modelMessages TEXT"
    )


def test_memory_and_chats_create_the_index_the_same_way():
    redis = FakeRedis()
    assert AgentMemory(redis).index.create_command() == ChatHistory(redis).index.create_command()


def test_a_0_2_text_index_is_refused_with_the_fix_and_never_dropped():
    redis = FakeRedis(OLD_TEXT_INDEX)
    with pytest.raises(RuntimeError, match="SEARCH.DROP agentkit"):
        AgentMemory(redis).recall("x", user_id="u1")
    assert "SEARCH.DROP" not in redis.ops()
    assert redis.queries() == []  # no pointless keyword fallback against the same refusal


def test_an_index_that_vanishes_during_create_is_not_marked_ready():
    redis = FakeRedis()
    redis.wait_result = 0
    memory = AgentMemory(redis)
    with pytest.raises(RuntimeError):
        memory.index.ensure()
    assert not memory.index._ready


# -- recall --------------------------------------------------------------------------------------


def test_hybrid_recall_fuses_keyword_and_meaning_for_this_user_only():
    redis = FakeRedis(HYBRID, [memory_row("1", "Weeks start Monday", 0.03)])
    memory = AgentMemory(redis, min_score=5)
    hits = memory.recall("what day does the week begin", user_id="u1", top_k=3)
    assert [(h.text, h.retrieval) for h in hits] == [("Weeks start Monday", "hybrid")]
    (query,) = redis.queries()
    keyword, ann = query["$rrf"]["retrievers"]
    assert keyword == {**USER, "text": {"$smart": "what day does the week begin"}}
    assert ann == {
        "$ann": {"field": "text", "query": "what day does the week begin", "filter": USER}
    }


@pytest.mark.parametrize(
    "error",
    [
        UpstashError("ERR dot metric only accepts unit-length vectors"),
        httpx.ConnectError("connection reset"),
        httpx.ReadTimeout("read timed out"),
    ],
)
def test_a_failed_hybrid_query_falls_back_to_keyword_once_with_min_score(error):
    redis = FakeRedis(HYBRID, [memory_row("1", "strong", 3.0), memory_row("2", "weak", 0.2)])
    redis.hybrid_error = error
    memory = AgentMemory(redis, min_score=1)
    hits = memory.recall("billing for big accounts", user_id="u1")
    assert [(h.text, h.retrieval) for h in hits] == [("strong", "keyword")]
    assert ["$rrf" in q for q in redis.queries()] == [True, False]
    assert redis.queries()[1] == {**USER, "text": {"$smart": "billing for big accounts"}}


def test_a_failed_fallback_raises_for_the_caller_to_handle():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    redis.hybrid_error = redis.keyword_error = httpx.ConnectError("down")
    with pytest.raises(httpx.ConnectError):
        AgentMemory(redis).recall("x", user_id="u1")
    assert len(redis.queries()) == 2  # one hybrid attempt, one keyword attempt


def test_programming_errors_are_not_swallowed_by_the_fallback():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    redis.hybrid_error = TypeError("bug")
    with pytest.raises(TypeError):
        AgentMemory(redis).recall("x", user_id="u1")


def test_keyword_mode_never_uses_a_retriever():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    AgentMemory(redis).recall("x", user_id="u1", mode="keyword")
    assert all("$rrf" not in q for q in redis.queries())


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError):
        AgentMemory(FakeRedis()).recall("x", user_id="u1", mode="vector")


def test_an_empty_hybrid_result_checks_the_index_without_counting_a_retriever():
    redis = FakeRedis(HYBRID)
    assert AgentMemory(redis).recall("nothing", user_id="u1") == []
    assert [c[2] for c in redis.commands if c[0] == "SEARCH.COUNT"] == ["{}"]


# -- provider ------------------------------------------------------------------------------------


@pytest.fixture
def hybrid_provider(monkeypatch):
    env = {"UPSTASH_HERMES_USER_ID": "u1"}
    monkeypatch.setattr(provider_module, "get_secret", lambda n, d=None: env.get(n, d))
    redis = FakeRedis(HYBRID, [memory_row(str(i), f"m{i}") for i in range(5)])
    provider = UpstashMemoryProvider(redis)
    provider.initialize("s1", platform="cli")
    return provider, redis


def test_prefetch_injects_three_memories(hybrid_provider):
    provider, redis = hybrid_provider
    block = provider.prefetch("what do I prefer")
    assert block.count("\n- ") == 3
    (limit,) = [c[c.index("LIMIT") + 1] for c in redis.commands if c[0] == "SEARCH.QUERY"]
    assert limit == "3"


def test_prefetch_survives_a_redis_outage(hybrid_provider):
    provider, redis = hybrid_provider
    redis.hybrid_error = redis.keyword_error = httpx.ConnectError("down")
    assert provider.prefetch("anything") == ""


def test_the_search_tool_says_how_results_were_found(hybrid_provider):
    provider, _ = hybrid_provider
    result = json.loads(provider.handle_tool_call("upstash_memory_search", {"query": "m"}))
    assert {r["retrieval"] for r in result["results"]} == {"hybrid"}


def test_mirror_deletion_matches_by_keyword_only(hybrid_provider):
    provider, redis = hybrid_provider
    provider._all_matches("old entry")
    assert all("$rrf" not in q for q in redis.queries())


def test_wait_indexing_recreates_an_index_that_was_dropped_under_it():
    redis = FakeRedis(HYBRID, [memory_row(1)])
    memory = AgentMemory(redis)
    memory.index.ensure()
    redis.index_schema = None  # another client dropped it
    memory.index.wait_indexing()
    assert redis.index_schema == HYBRID and memory.index._ready
