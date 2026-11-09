"""Semantic (hybrid) recall and the index migration, against a scripted fake Redis."""

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
from upstash_hermes_memory import AgentMemory, ChatHistory, UpstashMemoryProvider
from upstash_hermes_memory import provider as provider_module
from upstash_hermes_memory._search import (
    SHARED_SCHEMA,
    describe,
    matches,
    shared_index,
    with_hybrid_text,
)
from upstash_hermes_memory.migrate import MigrationError, migrate
from upstash_redis.errors import UpstashError
from upstash_redis.search import deserialize_describe_response

MISMATCH = "ERR Index agentkit already exists with a different configuration"
HYBRID = with_hybrid_text(SHARED_SCHEMA)
USER = {"userId": {"$eq": "u1"}, "$mustNot": [{"kind": {"$eq": "chat"}}]}
PREFIXES = ["agentkit:memory:", "agentkit:chat:"]
quiet = print  # migration log lines show up in pytest output on failure only


@dataclass
class Row:
    key: str
    score: float
    data: dict[str, Any]


def memory_row(id, text="x", score=1.0):
    return Row(f"agentkit:memory:u1:{id}", score, {"text": text, "userId": "u1", "createdAt": 1})


def describe_reply(schema, name="agentkit", prefixes=("agentkit:chat:", "agentkit:memory:")):
    fields = [[f, t] + (["NOTOKENIZE"] if nt else []) for f, t, nt in schema]
    return ["name", name, "type", "JSON", "prefixes", list(prefixes), "language", "english",
            "schema", fields]  # fmt: skip


class FakeRedis:
    """A small model of Upstash Redis Search, enough for the index lifecycle and recall.

    Memory rows and a chat count are the index contents; `pending` memories become searchable at
    the next WAITINDEXING, as asynchronous indexing does. Every command is recorded.
    """

    def __init__(self, index_schema=None, memories=(), chats=0, *, parsed=False, alias_of=None):
        self.index_schema = list(index_schema) if index_schema else None
        self.memories = list(memories)
        self.chats = chats
        self.pending: list[Row] = []
        self.parsed = parsed  # answer DESCRIBE like the client does (an IndexDescription)
        self.alias_of = alias_of  # DESCRIBE resolves the name to this index
        self.hybrid_error: Exception | None = None
        self.keyword_error: Exception | None = None
        self.wait_result: int | None = None
        self.kv: dict[str, str] = {}
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
            if not self.index_schema:
                return None
            reply = describe_reply(self.index_schema, name=self.alias_of or command[1])
            return deserialize_describe_response(reply) if self.parsed else reply
        if op == "SEARCH.DROP":
            dropped, self.index_schema = self.index_schema is not None, None
            return int(dropped)
        if op == "SEARCH.WAITINDEXING":
            if self.wait_result is not None:
                return self.wait_result
            self.memories += self.pending
            self.pending = []
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
        if op == "GET":
            return self.kv.get(command[1])
        if op == "SET":
            self.kv[command[1]] = command[2]
            return "OK"
        if op == "DEL":
            return int(self.kv.pop(command[1], None) is not None)
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


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr("upstash_hermes_memory.migrate.time.sleep", lambda s: None)


# -- describe ------------------------------------------------------------------------------------


@pytest.mark.parametrize("parsed", [False, True])
def test_describe_reads_raw_and_client_parsed_replies_alike(parsed):
    redis = FakeRedis(HYBRID, parsed=parsed)
    found = describe(redis, "agentkit")
    assert matches(found, PREFIXES, HYBRID, "agentkit")
    assert not matches(found, PREFIXES, SHARED_SCHEMA, "agentkit")


def test_describe_sees_options_this_package_never_sets():
    reply = describe_reply(SHARED_SCHEMA)
    reply[-1][2] = ["text", "TEXT", "NOSTEM"]

    class Raw(FakeRedis):
        def execute(self, command):
            return reply

    assert not matches(describe(Raw(), "agentkit"), PREFIXES, SHARED_SCHEMA)


# -- index creation ------------------------------------------------------------------------------


def test_semantic_creates_text_as_the_only_hybrid_field():
    command = shared_index(FakeRedis(), "agentkit", semantic=True).create_command()
    assert " ".join(command).endswith(
        "SCHEMA kind TEXT NOTOKENIZE userId TEXT NOTOKENIZE text HYBRID sessionId TEXT NOTOKENIZE "
        "userMessages TEXT modelMessages TEXT"
    )


def test_memory_and_chats_create_the_index_the_same_way():
    redis = FakeRedis()
    assert (
        AgentMemory(redis, semantic=True).index.create_command()
        == ChatHistory(redis, semantic=True).index.create_command()
    )


@pytest.mark.parametrize("semantic, existing", [(True, SHARED_SCHEMA), (False, HYBRID)])
@pytest.mark.parametrize("parsed", [False, True])
def test_an_existing_index_of_the_other_kind_is_used_never_dropped(semantic, existing, parsed):
    redis = FakeRedis(existing, parsed=parsed)
    memory = AgentMemory(redis, semantic=semantic)
    memory.index.ensure()
    assert memory.index.actual_schema == list(existing)
    assert "SEARCH.DROP" not in redis.ops()


def test_an_unknown_index_definition_still_fails():
    redis = FakeRedis(SHARED_SCHEMA + [("extra", "TEXT", False)])
    with pytest.raises(UpstashError):
        AgentMemory(redis, semantic=True).index.ensure()
    assert "SEARCH.DROP" not in redis.ops()


def test_an_alias_to_another_index_is_not_accepted():
    redis = FakeRedis(SHARED_SCHEMA, alias_of="someone_else")
    with pytest.raises(UpstashError):
        AgentMemory(redis, semantic=True).index.ensure()


def test_an_index_that_vanishes_during_create_is_not_marked_ready():
    redis = FakeRedis()
    redis.wait_result = 0
    memory = AgentMemory(redis, semantic=True)
    with pytest.raises(RuntimeError):
        memory.index.ensure()
    assert not memory.index._ready


# -- recall --------------------------------------------------------------------------------------


def test_hybrid_recall_fuses_keyword_and_meaning_for_this_user_only():
    redis = FakeRedis(HYBRID, [memory_row("1", "Weeks start Monday", 0.03)])
    memory = AgentMemory(redis, semantic=True, min_score=5)
    hits = memory.recall("what day does the week begin", user_id="u1", top_k=3)
    assert [(h.text, h.retrieval) for h in hits] == [("Weeks start Monday", "hybrid")]
    (query,) = redis.queries()
    keyword, ann = query["$rrf"]["retrievers"]
    assert keyword == {**USER, "text": {"$smart": "what day does the week begin"}}
    assert ann == {
        "$ann": {"field": "text", "query": "what day does the week begin", "filter": USER}
    }


def test_semantic_on_a_keyword_index_recalls_by_keyword_and_says_so_once(caplog):
    redis = FakeRedis(SHARED_SCHEMA, [memory_row("1")])
    memory = AgentMemory(redis, semantic=True)
    with caplog.at_level(logging.WARNING):
        memory.recall("a", user_id="u1")
        memory.recall("b", user_id="u1")
    assert all("$rrf" not in q for q in redis.queries())
    assert len(caplog.records) == 1 and "migrate" in caplog.records[0].message


def test_semantic_off_on_a_hybrid_index_says_embeddings_go_on(caplog):
    redis = FakeRedis(HYBRID, [memory_row("1")])
    with caplog.at_level(logging.WARNING):
        AgentMemory(redis).recall("a", user_id="u1")
    assert "still embedded" in caplog.records[0].message


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
    memory = AgentMemory(redis, semantic=True, min_score=1)
    hits = memory.recall("billing for big accounts", user_id="u1")
    assert [(h.text, h.retrieval) for h in hits] == [("strong", "keyword")]
    assert ["$rrf" in q for q in redis.queries()] == [True, False]
    assert redis.queries()[1] == {**USER, "text": {"$smart": "billing for big accounts"}}


def test_a_failed_fallback_raises_for_the_caller_to_handle():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    redis.hybrid_error = redis.keyword_error = httpx.ConnectError("down")
    with pytest.raises(httpx.ConnectError):
        AgentMemory(redis, semantic=True).recall("x", user_id="u1")
    assert len(redis.queries()) == 2  # one hybrid attempt, one keyword attempt


def test_programming_errors_are_not_swallowed_by_the_fallback():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    redis.hybrid_error = TypeError("bug")
    with pytest.raises(TypeError):
        AgentMemory(redis, semantic=True).recall("x", user_id="u1")


def test_keyword_mode_never_uses_a_retriever():
    redis = FakeRedis(HYBRID, [memory_row("1")])
    AgentMemory(redis, semantic=True).recall("x", user_id="u1", mode="keyword")
    assert all("$rrf" not in q for q in redis.queries())


def test_an_unknown_mode_is_refused():
    with pytest.raises(ValueError):
        AgentMemory(FakeRedis(), semantic=True).recall("x", user_id="u1", mode="vector")


def test_an_empty_hybrid_result_checks_the_index_without_counting_a_retriever():
    redis = FakeRedis(HYBRID)
    assert AgentMemory(redis, semantic=True).recall("nothing", user_id="u1") == []
    assert [c[2] for c in redis.commands if c[0] == "SEARCH.COUNT"] == ["{}"]


def test_semantic_off_keeps_the_0_2_commands():
    redis = FakeRedis(SHARED_SCHEMA, [memory_row("1", "x", 2.0)])
    hits = AgentMemory(redis).recall("x", user_id="u1")
    assert redis.queries() == [{**USER, "text": {"$smart": "x"}}]
    assert hits[0].retrieval == "keyword"


# -- provider ------------------------------------------------------------------------------------


@pytest.fixture
def semantic_provider(monkeypatch):
    env = {"UPSTASH_HERMES_SEMANTIC": "1", "UPSTASH_HERMES_USER_ID": "u1"}
    monkeypatch.setattr(provider_module, "get_secret", lambda n, d=None: env.get(n, d))
    redis = FakeRedis(HYBRID, [memory_row(str(i), f"m{i}") for i in range(5)])
    provider = UpstashMemoryProvider(redis)
    provider.initialize("s1", platform="cli")
    return provider, redis


def test_the_env_flag_turns_semantic_on_for_both_stores(semantic_provider):
    provider, _ = semantic_provider
    assert provider._memory.semantic
    assert provider._chats.index.schema == provider._memory.index.schema == HYBRID


def test_prefetch_injects_three_memories_in_semantic_mode(semantic_provider):
    provider, redis = semantic_provider
    block = provider.prefetch("what do I prefer")
    assert block.count("\n- ") == 3
    (limit,) = [c[c.index("LIMIT") + 1] for c in redis.commands if c[0] == "SEARCH.QUERY"]
    assert limit == "3"


def test_prefetch_survives_a_redis_outage(semantic_provider):
    provider, redis = semantic_provider
    redis.hybrid_error = redis.keyword_error = httpx.ConnectError("down")
    assert provider.prefetch("anything") == ""


def test_the_search_tool_says_how_results_were_found(semantic_provider):
    provider, _ = semantic_provider
    result = json.loads(provider.handle_tool_call("upstash_memory_search", {"query": "m"}))
    assert {r["retrieval"] for r in result["results"]} == {"hybrid"}


def test_mirror_deletion_matches_by_keyword_only(semantic_provider):
    provider, redis = semantic_provider
    provider._all_matches("old entry")
    assert all("$rrf" not in q for q in redis.queries())


# -- migration -----------------------------------------------------------------------------------


def migrated(redis, to="hybrid", **kwargs):
    return migrate(redis, namespace="agentkit", to=to, log=quiet, **kwargs)


def test_migration_rebuilds_a_keyword_index_and_checks_it():
    redis = FakeRedis(SHARED_SCHEMA, [memory_row(i) for i in range(7)], chats=2)
    assert migrated(redis) == "migrated"
    ops = redis.ops()
    assert ops.index("SET") < ops.index("SEARCH.DROP") < ops.index("SEARCH.CREATE")
    assert redis.index_schema == HYBRID
    assert redis.kv == {}  # baseline removed once checked


def test_pending_updates_are_settled_before_the_baseline():
    redis = FakeRedis(SHARED_SCHEMA, [memory_row(1)], chats=1)
    redis.pending = [memory_row(2)]  # written just before the clients stopped
    assert migrated(redis) == "migrated"
    first_count = redis.ops().index("SEARCH.COUNT")
    assert redis.ops().index("SEARCH.WAITINDEXING") < first_count


def test_migration_back_to_keyword_restores_the_0_2_index():
    redis = FakeRedis(HYBRID, [memory_row(1)], chats=3)
    assert migrated(redis, to="keyword") == "migrated"
    assert redis.index_schema == list(SHARED_SCHEMA)


def test_migration_to_the_current_kind_does_nothing():
    redis = FakeRedis(HYBRID, [memory_row(1)])
    assert migrated(redis) == "unchanged"
    assert "SEARCH.DROP" not in redis.ops()


@pytest.mark.parametrize(
    "redis",
    [
        FakeRedis(SHARED_SCHEMA + [("extra", "TEXT", False)]),
        FakeRedis(SHARED_SCHEMA, alias_of="agentkit_v2"),
    ],
)
def test_migration_refuses_an_index_it_did_not_create_or_an_alias(redis):
    with pytest.raises(MigrationError, match="refusing"):
        migrated(redis)
    assert "SEARCH.DROP" not in redis.ops()


def test_a_declined_migration_drops_nothing():
    redis = FakeRedis(SHARED_SCHEMA)
    with pytest.raises(MigrationError, match="cancelled"):
        migrated(redis, confirm=lambda plan: False)
    assert "SEARCH.DROP" not in redis.ops() and redis.kv == {}


def test_a_failed_drop_changes_nothing():
    class NoDrop(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.DROP":
                raise httpx.ReadTimeout("timed out")
            return super().execute(command)

    redis = NoDrop(SHARED_SCHEMA, [memory_row(1)])
    with pytest.raises(MigrationError, match="nothing changed"):
        migrated(redis)
    assert redis.index_schema == list(SHARED_SCHEMA) and redis.kv == {}


def test_a_failed_rebuild_says_where_things_stand_and_resumes():
    class NoCreate(FakeRedis):
        broken = True

        def execute(self, command):
            if command[0] == "SEARCH.CREATE" and self.broken:
                self.commands.append(command)
                raise httpx.ReadTimeout("read timed out")
            return super().execute(command)

    redis = NoCreate(SHARED_SCHEMA, [memory_row(1), memory_row(2)], chats=1)
    with pytest.raises(MigrationError, match="The index is absent.*--to keyword"):
        migrated(redis)
    assert redis.ops().count("SEARCH.CREATE") == 3
    assert "agentkit:migrate:baseline" in redis.kv

    redis.broken = False  # the server is back: the same command resumes and checks the baseline
    assert migrated(redis) == "migrated"
    assert redis.index_schema == HYBRID and redis.kv == {}


def test_a_timed_out_create_that_succeeded_is_not_repeated():
    class SlowCreate(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.CREATE":
                super().execute(command)
                raise httpx.ReadTimeout("read timed out")
            return super().execute(command)

    redis = SlowCreate(SHARED_SCHEMA, [memory_row(1)])
    assert migrated(redis) == "migrated"
    assert redis.ops().count("SEARCH.CREATE") == 1


def test_a_count_change_is_reported_and_rechecked_on_the_next_run():
    class Writer(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.DROP":
                self.memories.append(memory_row("late"))  # a client kept writing
            return super().execute(command)

    redis = Writer(SHARED_SCHEMA, [memory_row(i) for i in range(3)])
    with pytest.raises(MigrationError, match="still writing"):
        migrated(redis)
    assert "agentkit:migrate:baseline" in redis.kv  # kept: a rerun checks again, not "unchanged"
    with pytest.raises(MigrationError, match="still writing"):
        migrated(redis)

    redis.memories.pop()  # the stray write is dealt with
    assert migrated(redis) == "resumed"
    assert redis.kv == {}


def test_lost_memories_are_caught_by_key_not_just_by_count():
    class Swap(FakeRedis):
        def execute(self, command):
            if command[0] == "SEARCH.DROP":
                self.memories = [memory_row("other")]  # same count, different documents
            return super().execute(command)

    redis = Swap(SHARED_SCHEMA, [memory_row("mine")])
    with pytest.raises(MigrationError, match="lost 1 sampled"):
        migrated(redis)


def test_a_pending_migration_in_the_other_direction_blocks_a_new_one():
    redis = FakeRedis(None)
    redis.kv["agentkit:migrate:baseline"] = json.dumps({"to": "hybrid", "memories": 0, "chats": 0})
    with pytest.raises(MigrationError, match="--to hybrid first"):
        migrated(redis, to="keyword")
