"""The Hermes provider: its contract with Hermes, then its lifecycle against the test Redis."""

import json

import pytest
from upstash_hermes_memory import UpstashMemoryProvider
from upstash_hermes_memory import provider as provider_module
from upstash_hermes_memory.provider import _key_part, rewind_transcript

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
    provider._memory.index.ensure()
    provider._chats.index.ensure()
    yield provider
    provider._memory.index.drop()
    provider._chats.index.drop()


def test_user_and_session_ids_are_made_key_safe(provider):
    assert provider._user_id == "arda"
    assert provider._session_id == "20261022_120000_ab%3Acd"


def test_save_then_prefetch(provider):
    saved = json.loads(
        provider.handle_tool_call(
            "upstash_memory_save", {"text": "The user's dog is named Karabas"}
        )
    )
    assert saved["saved"] is True

    # No waiting here: the save tool only returns once the fact is searchable.
    block = provider.prefetch("what is my dog called?")
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

    provider._chats.index.wait_indexing()
    found = json.loads(provider.handle_tool_call("upstash_chat_search", {"query": "Lisbon"}))[
        "sessions"
    ]
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
    hits = provider._memory.recall("Turkish", user_id="arda")  # mirroring waits for indexing
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


def test_key_parts_are_encoded_one_to_one():
    assert _key_part("arda") == "arda"
    assert _key_part("alice:work") == "alice%3Awork"
    assert _key_part("50%:off") == "50%25%3Aoff"
    ids = ["alice:work", "alice_work", "alice%3Awork", "alice%work"]
    assert len({_key_part(i) for i in ids}) == len(ids)


def test_prefixes_come_from_the_hermes_profile(monkeypatch):
    # In a multiplexed gateway a profile's .env is only reachable through get_secret.
    profile = {
        "UPSTASH_HERMES_MEMORY_PREFIX": "team:memory",
        "UPSTASH_HERMES_CHAT_PREFIX": "team:chat",
    }
    monkeypatch.delenv("UPSTASH_HERMES_MEMORY_PREFIX", raising=False)
    monkeypatch.delenv("UPSTASH_HERMES_CHAT_PREFIX", raising=False)
    monkeypatch.setattr(
        provider_module, "get_secret", lambda name, default=None: profile.get(name, default)
    )
    provider = UpstashMemoryProvider(object())
    provider.initialize("s", platform="cli")
    assert (provider._memory.prefix, provider._chats.prefix) == ("team:memory", "team:chat")


def _turns(*texts):
    out = []
    for user, assistant in texts:
        out += [{"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
    return out


def test_rewind_drops_the_undone_turns():
    saved = _turns(("a", "1"), ("b", "2"), ("c", "3"))
    after_undo = _turns(("a", "1"), ("b", "2"))
    assert rewind_transcript(saved, after_undo) == _turns(("a", "1"), ("b", "2"))
    assert rewind_transcript(saved, _turns(("a", "1"))) == _turns(("a", "1"))
    assert rewind_transcript(saved, []) == []


def test_rewind_counts_repeated_messages():
    saved = _turns(("yes", "1"), ("yes", "2"), ("no", "3"))
    assert rewind_transcript(saved, _turns(("yes", "1"))) == _turns(("yes", "1"))
    assert rewind_transcript(saved, _turns(("yes", "1"), ("yes", "2"))) == _turns(
        ("yes", "1"), ("yes", "2")
    )


def test_rewind_matches_multimodal_messages_as_hermes_flattens_them():
    saved = _turns(("[1 image] what is this?", "a cat"), ("thanks", "np"))
    history = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "data:"}},
                {"type": "text", "text": "what is this?"},
            ],
        },
        {"role": "assistant", "content": "a cat"},
        {"role": "tool", "content": "ignored"},
    ]
    assert rewind_transcript(saved, history) == _turns(("[1 image] what is this?", "a cat"))


def test_undo_removes_the_undone_turn_from_redis(provider):
    provider.sync_turn("plan Kyoto", "ok", session_id="s-undo")
    provider.sync_turn("book the secret hotel", "done", session_id="s-undo")
    # /undo of the second turn, then a new turn: Hermes passes its post-undo history plus the turn.
    provider.on_session_switch("s-undo", rewound=True)
    history = _turns(("plan Kyoto", "ok")) + _turns(("plan Osaka instead", "sure"))
    provider.sync_turn("plan Osaka instead", "sure", session_id="s-undo", messages=history)

    doc = provider._chats.get_chat("s-undo", user_id="arda")
    assert [m["content"] for m in doc["messages"]] == [
        "plan Kyoto",
        "ok",
        "plan Osaka instead",
        "sure",
    ]
    provider._chats.index.wait_indexing()
    assert provider._chats.search_chats("secret hotel", user_id="arda") == []


def test_undo_then_exit_still_cleans_redis(provider):
    provider.sync_turn("first", "one", session_id="s-exit")
    provider.sync_turn("second", "two", session_id="s-exit")
    provider.on_session_switch("s-exit", rewound=True)
    provider.on_session_end(_turns(("first", "one")))
    doc = provider._chats.get_chat("s-exit", user_id="arda")
    assert [m["content"] for m in doc["messages"]] == ["first", "one"]
