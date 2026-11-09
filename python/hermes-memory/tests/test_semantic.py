"""Semantic (hybrid) recall and the index migration, against a scripted fake Redis."""

import json
import logging
from dataclasses import dataclass
from typing import Any

import pytest
from upstash_hermes_memory import AgentMemory, ChatHistory, UpstashMemoryProvider
from upstash_hermes_memory import provider as provider_module
from upstash_hermes_memory._search import SHARED_SCHEMA, shared_index, with_hybrid_text
from upstash_hermes_memory.migrate import MigrationError, migrate
from upstash_redis.errors import UpstashError

MISMATCH = "ERR Index agentkit already exists with a different configuration"


@dataclass
class Row:
    key: str
    score: float
    data: dict[str, Any]


def describe_reply(schema, name="agentkit", prefixes=("agentkit:chat:", "agentkit:memory:")):
    fields = [[f, t] + (["NOTOKENIZE"] if nt else []) for f, t, nt in schema]
    return ["name", name, "type", "JSON", "prefixes", list(prefixes), "language", "english",
            "schema", fields]  # fmt: skip


class FakeRedis:
    """Answers search commands from a small script; records every command it gets."""

    def __init__(self, index_schema=None, rows=(), fail_hybrid=False, count=None):
        self.index_schema = index_schema  # None: no index
        self.rows = list(rows)
        self.fail_hybrid = fail_hybrid
        self.count = count
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
        if op == "SEARCH.DESCRIBE":
            return describe_reply(self.index_schema) if self.index_schema else None
        if op == "SEARCH.DROP":
            dropped, self.index_schema = self.index_schema is not None, None
            return int(dropped)
        if op == "SEARCH.WAITINDEXING":
            return 1 if self.index_schema else 0
        if op == "SEARCH.QUERY":
            if self.index_schema is None:
                return []
            filter = json.loads(command[2])
            if "$rrf" in filter and self.fail_hybrid:
                raise UpstashError("ERR dot metric only accepts unit-length vectors")
            return list(self.rows)
        if op == "SEARCH.COUNT":
            if self.index_schema is None:
                return -1
            if "$rrf" in json.loads(command[2]) or "$ann" in json.loads(command[2]):
                raise UpstashError("ERR $ann cannot be used with SEARCH.COUNT")
            return self.count if self.count is not None else len(self.rows)
        return 1

    def delete(self, key):
        self.commands.append(["DEL", key])
        return 1

    def expire(self, key, seconds):
        return True

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


HYBRID = with_hybrid_text(SHARED_SCHEMA)
USER = {"userId": {"$eq": "u1"}, "$mustNot": [{"kind": {"$eq": "chat"}}]}


def memory_row(id, text, score=1.0):
    return Row(f"agentkit:memory:u1:{id}", score, {"text": text, "userId": "u1", "createdAt": 1})


# -- index creation ------------------------------------------------------------------------------


def test_semantic_creates_text_as_the_only_hybrid_field():
    command = shared_index(FakeRedis(), "agentkit", semantic=True).create_command()
    assert " ".join(command).endswith(
        "SCHEMA kind TEXT NOTOKENIZE userId TEXT NOTOKENIZE text HYBRID sessionId TEXT NOTOKENIZE "
        "userMessages TEXT modelMessages TEXT"
    )


def test_memory_and_chats_create_the_index_the_same_way():
    redis = FakeRedis()
    memory = AgentMemory(redis, semantic=True)
    chats = ChatHistory(redis, semantic=True)
    assert memory.index.create_command() == chats.index.create_command()


@pytest.mark.parametrize("semantic, existing", [(True, SHARED_SCHEMA), (False, HYBRID)])
def test_an_existing_index_of_the_other_kind_is_used_never_dropped(semantic, existing):
    redis = FakeRedis(index_schema=list(existing))
    memory = AgentMemory(redis, semantic=semantic)
    memory.index.ensure()
    assert memory.index.actual_schema == list(existing)
    assert not [c for c in redis.commands if c[0] == "SEARCH.DROP"]


def test_an_unknown_index_definition_still_fails():
    redis = FakeRedis(index_schema=SHARED_SCHEMA + [("extra", "TEXT", False)])
    with pytest.raises(UpstashError):
        AgentMemory(redis, semantic=True).index.ensure()
    assert not [c for c in redis.commands if c[0] == "SEARCH.DROP"]


# -- recall --------------------------------------------------------------------------------------


def test_hybrid_recall_fuses_keyword_and_meaning_for_this_user_only():
    redis = FakeRedis(index_schema=list(HYBRID), rows=[memory_row("1", "Weeks start Monday", 0.03)])
    memory = AgentMemory(redis, semantic=True, min_score=5)
    hits = memory.recall("what day does the week begin", user_id="u1", top_k=3)
    assert [(h.text, h.retrieval) for h in hits] == [("Weeks start Monday", "hybrid")]
    (query,) = redis.queries()
    keyword, ann = query["$rrf"]["retrievers"]
    assert keyword == {**USER, "text": {"$smart": "what day does the week begin"}}
    assert ann == {
        "$ann": {"field": "text", "query": "what day does the week begin", "filter": USER}
    }


def test_semantic_on_a_keyword_index_recalls_by_keyword_and_says_so(caplog):
    redis = FakeRedis(index_schema=list(SHARED_SCHEMA), rows=[memory_row("1", "x")])
    memory = AgentMemory(redis, semantic=True)
    with caplog.at_level(logging.WARNING):
        memory.recall("a", user_id="u1")
        memory.recall("b", user_id="u1")
    assert all("$rrf" not in q for q in redis.queries())
    assert [r.message for r in caplog.records].count(caplog.records[0].message) == 1
    assert "migrate" in caplog.records[0].message


def test_a_failed_hybrid_query_falls_back_to_keyword_once_with_min_score():
    rows = [memory_row("1", "strong", 3.0), memory_row("2", "weak", 0.2)]
    redis = FakeRedis(index_schema=list(HYBRID), rows=rows, fail_hybrid=True)
    memory = AgentMemory(redis, semantic=True, min_score=1)
    hits = memory.recall("billing for big accounts", user_id="u1")
    assert [(h.text, h.retrieval) for h in hits] == [("strong", "keyword")]
    assert ["$rrf" in q for q in redis.queries()] == [True, False]
    assert redis.queries()[1] == {**USER, "text": {"$smart": "billing for big accounts"}}


def test_keyword_mode_never_uses_a_retriever():
    redis = FakeRedis(index_schema=list(HYBRID), rows=[memory_row("1", "x")])
    AgentMemory(redis, semantic=True).recall("x", user_id="u1", mode="keyword")
    assert all("$rrf" not in q for q in redis.queries())


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError):
        AgentMemory(FakeRedis(), semantic=True).recall("x", user_id="u1", mode="vector")


def test_an_empty_hybrid_result_checks_the_index_without_counting_a_retriever():
    redis = FakeRedis(index_schema=list(HYBRID), rows=[])
    assert AgentMemory(redis, semantic=True).recall("nothing", user_id="u1") == []
    counts = [c[2] for c in redis.commands if c[0] == "SEARCH.COUNT"]
    assert counts == ["{}"]


def test_semantic_off_keeps_the_0_2_commands():
    redis = FakeRedis(index_schema=list(SHARED_SCHEMA), rows=[memory_row("1", "x", 2.0)])
    hits = AgentMemory(redis).recall("x", user_id="u1")
    assert redis.queries() == [{**USER, "text": {"$smart": "x"}}]
    assert hits[0].retrieval == "keyword"


# -- provider ------------------------------------------------------------------------------------


@pytest.fixture
def semantic_provider(monkeypatch):
    env = {"UPSTASH_HERMES_SEMANTIC": "1", "UPSTASH_HERMES_USER_ID": "u1"}
    monkeypatch.setattr(provider_module, "get_secret", lambda n, d=None: env.get(n, d))
    redis = FakeRedis(
        index_schema=list(HYBRID), rows=[memory_row(str(i), f"m{i}") for i in range(5)]
    )
    provider = UpstashMemoryProvider(redis)
    provider.initialize("s1", platform="cli")
    return provider, redis


def test_the_env_flag_turns_semantic_on_for_both_stores(semantic_provider):
    provider, _ = semantic_provider
    assert provider._memory.semantic
    assert provider._chats.index.schema == provider._memory.index.schema == HYBRID


def test_prefetch_asks_for_three_memories_in_semantic_mode(semantic_provider):
    provider, redis = semantic_provider
    provider.prefetch("what do I prefer")
    (limit,) = [c[c.index("LIMIT") + 1] for c in redis.commands if c[0] == "SEARCH.QUERY"]
    assert limit == "3"


def test_the_search_tool_says_how_results_were_found(semantic_provider):
    provider, _ = semantic_provider
    result = json.loads(provider.handle_tool_call("upstash_memory_search", {"query": "m"}))
    assert {r["retrieval"] for r in result["results"]} == {"hybrid"}


def test_mirror_deletion_matches_by_keyword_only(semantic_provider):
    provider, redis = semantic_provider
    provider._all_matches("old entry")
    assert all("$rrf" not in q for q in redis.queries())


# -- migration -----------------------------------------------------------------------------------


def test_migration_rebuilds_a_keyword_index_and_checks_the_counts():
    redis = FakeRedis(index_schema=list(SHARED_SCHEMA), count=7)
    assert migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None) == "migrated"
    ops = [c[0] for c in redis.commands]
    assert ops.index("SEARCH.DROP") < ops.index("SEARCH.CREATE") < ops.index("SEARCH.WAITINDEXING")
    assert redis.index_schema == list(HYBRID)


def test_migration_back_to_keyword_restores_the_0_2_index():
    redis = FakeRedis(index_schema=list(HYBRID), count=3)
    migrate(redis, namespace="agentkit", to="keyword", log=lambda m: None)
    assert redis.index_schema == list(SHARED_SCHEMA)


def test_migration_to_the_current_kind_does_nothing():
    redis = FakeRedis(index_schema=list(HYBRID))
    assert migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None) == "unchanged"
    assert "SEARCH.DROP" not in [c[0] for c in redis.commands]


def test_migration_refuses_an_index_it_did_not_create():
    redis = FakeRedis(index_schema=SHARED_SCHEMA + [("extra", "TEXT", False)])
    with pytest.raises(MigrationError, match="refusing"):
        migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None)
    assert "SEARCH.DROP" not in [c[0] for c in redis.commands]


def test_a_declined_migration_drops_nothing():
    redis = FakeRedis(index_schema=list(SHARED_SCHEMA))
    with pytest.raises(MigrationError, match="cancelled"):
        migrate(redis, namespace="agentkit", to="hybrid", confirm=lambda p: False, log=print)
    assert "SEARCH.DROP" not in [c[0] for c in redis.commands]


def test_a_failed_rebuild_says_how_to_recover(monkeypatch):
    monkeypatch.setattr("upstash_hermes_memory.migrate.time.sleep", lambda s: None)

    class NoCreate(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.CREATE":
                self.commands.append(command)
                raise TimeoutError("read timed out")
            return super().execute(command)

    redis = NoCreate(index_schema=list(SHARED_SCHEMA))
    with pytest.raises(MigrationError, match="--to keyword"):
        migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None)
    assert [c[0] for c in redis.commands].count("SEARCH.CREATE") == 3


def test_a_timed_out_create_that_succeeded_is_not_repeated():
    class SlowCreate(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.CREATE":
                super().execute(command)
                raise TimeoutError("read timed out")
            return super().execute(command)

    redis = SlowCreate(index_schema=list(SHARED_SCHEMA), count=2)
    assert migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None) == "migrated"
    assert [c[0] for c in redis.commands].count("SEARCH.CREATE") == 1


def test_a_count_change_during_the_rebuild_is_reported():
    class Writer(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.DROP":
                self.count = 8  # a client kept writing
            return super().execute(command)

    redis = Writer(index_schema=list(SHARED_SCHEMA), count=7)
    with pytest.raises(MigrationError, match="still writing"):
        migrate(redis, namespace="agentkit", to="hybrid", log=lambda m: None)
