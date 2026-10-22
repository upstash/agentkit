"""The Hermes provider: its contract with Hermes, then its lifecycle against the test Redis."""

import json

import pytest
from conftest import eventually
from upstash_hermes_memory import UpstashMemoryProvider

# Tools Hermes itself owns; a provider tool with one of these names is dropped (memory_manager.py).
HERMES_CORE_TOOL_NAMES = {"memory", "session_search", "todo", "clarify"}


def test_tool_schemas_are_prefixed_and_well_formed():
    schemas = UpstashMemoryProvider().get_tool_schemas()
    names = [s["name"] for s in schemas]
    assert all(n.startswith("upstash_") for n in names)
    assert not HERMES_CORE_TOOL_NAMES & set(names)
    for schema in schemas:
        assert schema["parameters"]["type"] == "object"
        assert set(schema["parameters"]["required"]) <= set(schema["parameters"]["properties"])


def test_is_available_needs_both_credentials(monkeypatch):
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.setenv("UPSTASH_REDIS_REST_TOKEN", "t")
    assert not UpstashMemoryProvider().is_available()
    monkeypatch.setenv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
    assert UpstashMemoryProvider().is_available()


def test_tool_errors_come_back_as_json():
    result = json.loads(
        UpstashMemoryProvider().handle_tool_call("upstash_memory_save", {"text": "x"})
    )
    assert "error" in result


@pytest.fixture
def provider(redis, prefix, monkeypatch):
    monkeypatch.setenv("UPSTASH_HERMES_MEMORY_PREFIX", f"{prefix}:memory")
    monkeypatch.setenv("UPSTASH_HERMES_CHAT_PREFIX", f"{prefix}:chat")
    monkeypatch.delenv("UPSTASH_HERMES_USER_ID", raising=False)
    provider = UpstashMemoryProvider(redis)
    provider.initialize("20261022_120000_ab:cd", platform="cli", agent_identity="arda")
    yield provider
    provider._memory.index.drop()
    provider._chats.index.drop()


def test_user_and_session_ids_are_made_key_safe(provider):
    assert provider._user_id == "arda"
    assert provider._session_id == "20261022_120000_ab_cd"


def test_save_then_prefetch(provider):
    saved = json.loads(
        provider.handle_tool_call(
            "upstash_memory_save", {"text": "The user's dog is named Karabas"}
        )
    )
    assert saved["saved"] is True

    block = eventually(lambda: provider.prefetch("what is my dog called?"))
    assert block.startswith("## Upstash Memory")
    assert "Karabas" in block

    found = json.loads(provider.handle_tool_call("upstash_memory_search", {"query": "dog"}))
    assert [r["id"] for r in found["results"]] == [saved["id"]]

    forgotten = json.loads(provider.handle_tool_call("upstash_memory_forget", {"id": saved["id"]}))
    assert forgotten == {"forgotten": True}


def test_turns_become_a_searchable_transcript(provider):
    provider.sync_turn("I'm planning a trip to Lisbon", "Great, when?", session_id="s-1")
    provider.sync_turn("In May", "May is lovely there.", session_id="s-1")

    doc = provider._chats.get_chat("s-1", user_id="arda")
    assert [m["role"] for m in doc["messages"]] == ["user", "assistant", "user", "assistant"]

    found = eventually(
        lambda: json.loads(provider.handle_tool_call("upstash_chat_search", {"query": "Lisbon"}))[
            "sessions"
        ]
    )
    assert [s["session_id"] for s in found] == ["s-1"]


def test_a_resumed_session_appends_instead_of_overwriting(provider, redis):
    provider.sync_turn("first", "one", session_id="s-2")
    resumed = UpstashMemoryProvider(redis)
    resumed.initialize("s-2", platform="cli", agent_identity="arda")
    resumed.sync_turn("second", "two", session_id="s-2")
    doc = resumed._chats.get_chat("s-2", user_id="arda")
    assert [m["content"] for m in doc["messages"]] == ["first", "one", "second", "two"]


def test_built_in_memory_writes_are_mirrored(provider):
    provider.on_memory_write("add", "user", "Prefers answers in Turkish")
    provider.on_memory_write("remove", "user", "Prefers answers in Turkish")  # not mirrored
    hits = eventually(lambda: provider._memory.recall("Turkish", user_id="arda"))
    assert [(h.text, h.metadata) for h in hits] == [
        ("Prefers answers in Turkish", {"source": "hermes", "target": "user"})
    ]


def test_subagents_read_but_never_write(provider, redis):
    sub = UpstashMemoryProvider(redis)
    sub.initialize("s-sub", platform="cli", agent_identity="arda", agent_context="subagent")
    sub.sync_turn("hello", "hi", session_id="s-sub")
    sub.on_memory_write("add", "memory", "should not land")
    refused = json.loads(sub.handle_tool_call("upstash_memory_save", {"text": "nope"}))
    assert "error" in refused
    assert sub._chats.get_chat("s-sub", user_id="arda") is None
    assert sub._memory.count(user_id="arda") == 0
