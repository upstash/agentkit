"""AgentMemory and ChatHistory against the shared test Redis (skipped without secrets)."""

import uuid

import pytest
from upstash_hermes_memory import AgentMemory, ChatHistory


def test_round_trip(redis):
    # Smoke test for the CI wiring: the pinned client reaches the shared test database. It uses a
    # plain key with a TTL, never a search index, so it does not count against the 10-index cap.
    key = f"agentkit-test:python:{uuid.uuid4().hex}"
    try:
        assert redis.set(key, "hermes", ex=60)
        assert redis.get(key) == "hermes"
    finally:
        redis.delete(key)
    assert redis.get(key) is None


@pytest.fixture
def memory(redis, prefix):
    memory = AgentMemory(redis, prefix=f"{prefix}:memory", enable_telemetry=False)
    # Index first, then seed: writes are indexed as writes, never left to the create-time backfill.
    memory.index.ensure()
    yield memory
    memory.index.drop()


@pytest.fixture
def chats(redis, prefix):
    chats = ChatHistory(redis, prefix=f"{prefix}:chat", enable_telemetry=False)
    chats.index.ensure()
    yield chats
    chats.index.drop()


def test_memory_lifecycle(memory):
    memory.add("Arda prefers dark roast coffee", user_id="u1", id="coffee")
    memory.add("Arda's cat is called Pamuk", user_id="u1")
    memory.add("Someone else likes coffee too", user_id="u2")
    memory.index.wait_indexing()

    hits = memory.recall("coffee", user_id="u1")
    assert [h.id for h in hits] == ["coffee"]
    assert hits[0].text == "Arda prefers dark roast coffee"
    assert hits[0].score > 0

    assert memory.count(user_id="u1") == 2
    assert len(memory.list(user_id="u1")) == 2
    assert memory.get("coffee", user_id="u1").text == "Arda prefers dark roast coffee"
    assert memory.get("coffee", user_id="u2") is None

    assert memory.forget("coffee", user_id="u1")
    assert memory.get("coffee", user_id="u1") is None
    memory.index.wait_indexing()
    assert memory.count(user_id="u1") == 1
    assert memory.recall("coffee", user_id="u1") == []


def test_memory_reads_documents_written_by_the_ts_sdk(redis, memory):
    # Exactly what AgentMemory.add writes from TypeScript, metadata spread at the top level.
    redis.execute(
        [
            "JSON.SET",
            f"{memory.prefix}:u1:from-ts",
            "$",
            '{"text":"deploys happen on Fridays","userId":"u1","createdAt":1700000000000,"team":"core"}',
        ]
    )
    memory.index.wait_indexing()
    hits = memory.recall("deploys", user_id="u1")
    assert [(h.id, h.created_at, h.metadata) for h in hits] == [
        ("from-ts", 1700000000000, {"team": "core"})
    ]


def test_chat_history_lifecycle(chats):
    first = chats.save_chat(
        "s1",
        [
            {"role": "user", "content": "plan a trip to Kyoto"},
            {"role": "assistant", "content": "sure"},
        ],
        user_id="u1",
        title="Kyoto",
    )
    second = chats.save_chat(
        "s1",
        [
            {"role": "user", "content": "plan a trip to Kyoto"},
            {"role": "assistant", "content": "done"},
        ],
        user_id="u1",
    )
    assert second["createdAt"] == first["createdAt"]
    assert second["title"] == "Kyoto"  # kept from the first save
    chats.save_chat("s2", [{"role": "user", "content": "fix my bike"}], user_id="u1")
    chats.index.wait_indexing()

    doc = chats.get_chat("s1", user_id="u1")
    assert doc["userMessages"] == "plan a trip to Kyoto"
    assert doc["modelMessages"] == "done"

    hits = chats.search_chats("Kyoto", user_id="u1")
    assert [h.session_id for h in hits] == ["s1"]
    assert chats.search_chats("Kyoto", user_id="u2") == []

    listed = chats.list_chats(user_id="u1")
    assert [d["sessionId"] for d in listed] == ["s2", "s1"]  # most recently updated first

    assert chats.delete_chat("s1", user_id="u1")
    assert chats.get_chat("s1", user_id="u1") is None


def test_metadata_cannot_replace_the_document_fields(memory):
    for field in ("userId", "text", "createdAt"):
        with pytest.raises(ValueError, match=field):
            memory.add("x", user_id="alice", metadata={field: "bob"})
    memory.index.wait_indexing()
    assert memory.count(user_id="alice") == 0
    assert memory.count(user_id="bob") == 0


def test_memory_ids_may_contain_colons_like_in_the_ts_sdk(memory):
    memory.add("ship the beta", user_id="u1", id="project:42")
    memory.index.wait_indexing()
    assert [h.id for h in memory.recall("beta", user_id="u1")] == ["project:42"]
    assert memory.get("project:42", user_id="u1").text == "ship the beta"
    assert memory.forget("project:42", user_id="u1")


def test_search_recovers_when_another_client_drops_the_index(redis, memory):
    memory.add("the office moved to Kadikoy", user_id="u1")
    memory.index.wait_indexing()
    assert memory.recall("office", user_id="u1")
    # Someone else drops the shared index; this instance still believes it is there.
    redis.execute(["SEARCH.DROP", memory.index.name])
    hits = memory.recall("office", user_id="u1")
    assert [h.text for h in hits] == ["the office moved to Kadikoy"]
