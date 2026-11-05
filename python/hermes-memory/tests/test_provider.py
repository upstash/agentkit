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
    monkeypatch.setenv("UPSTASH_HERMES_NAMESPACE", prefix)
    monkeypatch.delenv("UPSTASH_HERMES_USER_ID", raising=False)
    provider = UpstashMemoryProvider(redis)
    provider.initialize("20261022_120000_abcd", platform="cli", agent_identity="arda")
    provider._memory.index.ensure()  # the one index memory and chats share
    yield provider
    provider._memory.index.drop()


def test_user_and_session_ids_are_used_as_they_are(provider):
    assert provider._user_id == "arda"
    assert provider._session_id == "20261022_120000_abcd"


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


def test_a_turn_sends_only_itself_once_the_chat_exists(provider, redis):
    # A long session must not re-send (or re-read) its whole transcript every turn: Redis caps a
    # request at 10 MB, so a full rewrite would stop saving the chat after a few months.
    provider.sync_turn("first " + "x" * 5000, "one", session_id="s-big")
    sent = []
    execute = redis.execute

    def recording(command):
        sent.append(command)
        return execute(command)

    redis.execute = recording
    try:
        provider.sync_turn("second", "two", session_id="s-big")
    finally:
        redis.execute = execute
    assert [c[0] for c in sent] == ["EVAL"]
    assert sum(len(str(part)) for part in sent[0][2:]) < 500
    doc = provider._chats.get_chat("s-big", user_id="arda")
    assert [m["content"][:5] for m in doc["messages"]] == ["first", "one", "secon", "two"]


def _fail_next_write(provider, monkeypatch):
    """Make the next chat write raise, as a network blip would; later writes go through."""
    chats = provider._chats
    calls = {"failed": False}

    def failing(method):
        real = getattr(chats, method)

        def wrapper(*args, **kwargs):
            if not calls["failed"]:
                calls["failed"] = True
                raise ConnectionError("blip")
            return real(*args, **kwargs)

        monkeypatch.setattr(chats, method, wrapper)

    failing("append_messages")
    failing("save_chat")
    return calls


def _contents(provider, sid):
    doc = provider._chats.get_chat(sid, user_id="arda")
    return [m["content"] for m in doc["messages"]] if doc else None


def test_a_failed_first_turn_is_saved_by_the_next_one(provider, monkeypatch):
    _fail_next_write(provider, monkeypatch)
    provider.sync_turn("u1", "a1", session_id="s-f1")
    assert _contents(provider, "s-f1") is None
    provider.sync_turn("u2", "a2", session_id="s-f1")
    assert _contents(provider, "s-f1") == ["u1", "a1", "u2", "a2"]


def test_a_failed_later_turn_is_saved_by_the_next_one(provider, monkeypatch):
    provider.sync_turn("u1", "a1", session_id="s-f2")
    _fail_next_write(provider, monkeypatch)
    provider.sync_turn("u2", "a2", session_id="s-f2")
    provider.sync_turn("u3", "a3", session_id="s-f2")
    assert _contents(provider, "s-f2") == ["u1", "a1", "u2", "a2", "u3", "a3"]


def test_a_failed_write_after_undo_still_cuts_and_keeps_the_turn(provider, monkeypatch):
    for user, reply in (("x", "1"), ("y", "2"), ("z", "3")):
        provider.sync_turn(user, reply, session_id="s-f3")
    provider.on_session_switch("s-f3", rewound=True)  # /undo of z
    _fail_next_write(provider, monkeypatch)
    after_undo = _turns(("x", "1"), ("y", "2"), ("w", "4"))
    provider.sync_turn("w", "4", session_id="s-f3", messages=after_undo)
    provider.sync_turn("v", "5", session_id="s-f3", messages=after_undo + _turns(("v", "5")))
    assert _contents(provider, "s-f3") == ["x", "1", "y", "2", "w", "4", "v", "5"]


def test_session_end_retries_a_failed_turn(provider, monkeypatch):
    _fail_next_write(provider, monkeypatch)
    provider.sync_turn("u1", "a1", session_id=provider._session_id)
    provider.on_session_end(_turns(("u1", "a1")))
    assert _contents(provider, provider._session_id) == ["u1", "a1"]


def _texts(provider, query):
    return sorted(h.text for h in provider._memory.recall(query, user_id="arda", top_k=20))


def test_built_in_memory_writes_are_mirrored(provider):
    provider.on_memory_write("add", "user", "Prefers answers in Turkish")
    hits = provider._memory.recall("Turkish", user_id="arda")  # mirroring waits for indexing
    assert [(h.text, h.metadata) for h in hits] == [
        ("Prefers answers in Turkish", {"source": "hermes", "target": "user"})
    ]


def test_built_in_corrections_replace_the_mirrored_fact(provider):
    # The shape Hermes sends (memory_manager.notify_memory_tool_write); a patch arrives like this too.
    provider.on_memory_write("add", "user", "Lives in Ankara")
    provider.on_memory_write(
        "replace",
        "user",
        "Lives in Izmir",
        metadata={"old_text": "Ankara", "previous_content": "Lives in Ankara"},
    )
    assert _texts(provider, "Lives in") == ["Lives in Izmir"]


def test_built_in_removals_delete_the_mirrored_fact(provider):
    provider.on_memory_write("add", "user", "Prefers answers in Turkish")
    provider.on_memory_write("add", "user", "Prefers short answers")
    provider.on_memory_write(
        "remove",
        "user",
        "",
        metadata={"old_text": "Turkish", "previous_content": "Prefers answers in Turkish"},
    )
    assert _texts(provider, "Prefers answers") == ["Prefers short answers"]


def test_removals_leave_other_targets_and_saved_memories_alone(provider):
    provider.handle_tool_call("upstash_memory_save", {"text": "Uses a standing desk"})
    provider.on_memory_write("add", "memory", "Uses a standing desk")
    provider.on_memory_write("add", "user", "Uses a standing desk")
    provider.on_memory_write(
        "remove", "user", "", metadata={"previous_content": "Uses a standing desk"}
    )
    hits = provider._memory.recall("standing desk", user_id="arda", top_k=20)
    assert sorted(h.metadata.get("target", "") for h in hits) == ["", "memory"]


def test_repeated_adds_keep_one_mirror_and_a_removal_deletes_it(provider):
    # Hermes reports a repeated add of an existing entry as a success and mirrors it again.
    for _ in range(25):
        provider.on_memory_write("add", "user", "Prefers answers in Turkish")
    assert _texts(provider, "Prefers answers in Turkish") == ["Prefers answers in Turkish"]
    provider.on_memory_write(
        "remove", "user", "", metadata={"previous_content": "Prefers answers in Turkish"}
    )
    assert _texts(provider, "Prefers answers in Turkish") == []


def test_removals_find_every_legacy_mirror_beyond_the_top_hits(provider):
    # Mirrors written by 0.1.x have random ids; 25 copies plus 25 better-ranked saved memories
    # used to leave copies behind past the first 20 hits.
    memory = provider._memory
    for _ in range(25):
        memory.add("Turkish", user_id="arda", metadata={"source": "hermes"})
        memory.add("Turkish", user_id="arda", metadata={"source": "hermes", "target": "user"})
    memory.index.wait_indexing()
    provider.on_memory_write("remove", "user", "", metadata={"previous_content": "Turkish"})
    hits = memory.recall("Turkish", user_id="arda", top_k=100)
    assert len(hits) == 25
    assert all("target" not in h.metadata for h in hits)


def test_old_text_alone_only_removes_an_unambiguous_match(provider):
    provider.on_memory_write("add", "user", "Drinks tea in the morning")
    provider.on_memory_write("add", "user", "Drinks coffee in the evening")
    provider.on_memory_write("remove", "user", "", metadata={"old_text": "Drinks"})  # ambiguous
    assert len(_texts(provider, "Drinks")) == 2
    provider.on_memory_write("remove", "user", "", metadata={"old_text": "tea"})
    assert _texts(provider, "Drinks") == ["Drinks coffee in the evening"]


def test_old_text_alone_finds_a_substring_search_would_miss(provider):
    # Full-text search doesn't match "ordinarycomp" inside "extraordinarycompany".
    provider.on_memory_write("add", "user", "Works at extraordinarycompany")
    provider.on_memory_write("add", "user", "Drinks tea in the morning")
    provider.on_memory_write("remove", "user", "", metadata={"old_text": "ordinarycomp"})
    assert [m.text for m in provider._memory.list(user_id="arda")] == ["Drinks tea in the morning"]


def test_subagents_read_but_never_write(provider, redis):
    sub = UpstashMemoryProvider(redis)
    sub.initialize("s-sub", platform="cli", agent_identity="arda", agent_context="subagent")
    sub.sync_turn("hello", "hi", session_id="s-sub")
    sub.on_memory_write("add", "memory", "should not land")
    refused = json.loads(sub.handle_tool_call("upstash_memory_save", {"text": "nope"}))
    assert "error" in refused
    assert sub._chats.get_chat("s-sub", user_id="arda") is None
    assert sub._memory.count(user_id="arda") == 0


def test_key_parts_match_the_ts_sdk():
    # The TS SDK stores these literally, so the provider must too, or the two read different keys.
    assert _key_part("team%ops", "user id") == "team%ops"
    assert _key_part("alice%3Awork", "user id") == "alice%3Awork"
    # The TS SDK refuses `:`, and any encoding of it could equal a literal TS id like the above.
    with pytest.raises(ValueError):
        _key_part("alice:work", "user id")


def test_a_refused_user_id_leaves_the_provider_inactive(monkeypatch):
    # Hermes swallows an initialize error and keeps the provider, so it must not fall back to
    # another user ("default") or keep writing.
    monkeypatch.setenv("UPSTASH_HERMES_USER_ID", "alice:work")
    provider = UpstashMemoryProvider(object())
    provider.initialize("s", platform="cli")
    assert provider._memory is None and provider._chats is None
    assert provider.prefetch("anything") == ""
    assert provider.system_prompt_block() == ""
    assert "error" in json.loads(provider.handle_tool_call("upstash_memory_search", {"query": "x"}))
    assert "error" in json.loads(provider.handle_tool_call("upstash_memory_save", {"text": "x"}))
    provider.sync_turn("hi", "hello", session_id="s")
    provider.on_memory_write("add", "memory", "a fact")  # no stores: nothing to write to


def test_a_session_id_with_a_colon_keeps_no_transcript(provider, redis):
    provider.sync_turn("hi", "hello", session_id="ab:cd")
    assert not redis.keys(f"{provider._chats.prefix}:*")


def test_ids_with_percent_are_shared_with_the_ts_sdk(provider, redis):
    # A TS `AgentMemory.add(text, { userId: "team%ops" })` writes this key and document.
    key = f"{provider._memory.prefix}:team%ops:from-ts"
    doc = {"text": "the deploy freeze starts friday", "userId": "team%ops", "createdAt": 1}
    redis.execute(["JSON.SET", key, "$", json.dumps(doc)])
    provider._user_id = _key_part("team%ops", "user id")
    assert provider._memory.get("from-ts", user_id=provider._user_id) is not None
    assert json.loads(provider.handle_tool_call("upstash_memory_forget", {"id": "from-ts"})) == {
        "forgotten": True
    }


def test_the_namespace_comes_from_the_hermes_profile(monkeypatch):
    # In a multiplexed gateway a profile's .env is only reachable through get_secret.
    profile = {"UPSTASH_HERMES_NAMESPACE": "team"}
    monkeypatch.delenv("UPSTASH_HERMES_NAMESPACE", raising=False)
    monkeypatch.setattr(
        provider_module, "get_secret", lambda name, default=None: profile.get(name, default)
    )
    provider = UpstashMemoryProvider(object())
    provider.initialize("s", platform="cli")
    assert (provider._memory.prefix, provider._chats.prefix) == ("team:memory", "team:chat")
    assert provider._memory.index.name == provider._chats.index.name == "team"


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, False),
        ({"UPSTASH_HERMES_TELEMETRY": "0"}, False),
        ({"UPSTASH_HERMES_TELEMETRY": "1"}, True),
        ({"UPSTASH_HERMES_TELEMETRY": "true", "UPSTASH_DISABLE_TELEMETRY": "1"}, False),
    ],
)
def test_telemetry_is_opt_in_for_the_redis_client_too(monkeypatch, env, expected):
    # Catalog rule 13: no telemetry unless asked, including upstash-redis's own headers.
    import upstash_redis

    created = {}

    class FakeRedis:
        def __init__(self, url, token, allow_telemetry=True):
            created["allow_telemetry"] = allow_telemetry
            self._headers = (
                {"Upstash-Telemetry-Sdk": "py-upstash-redis@v1.8.0"} if allow_telemetry else {}
            )

    for name in ("UPSTASH_HERMES_TELEMETRY", "UPSTASH_DISABLE_TELEMETRY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(upstash_redis, "Redis", FakeRedis)
    monkeypatch.setattr(
        provider_module, "get_secret", lambda name, default=None: env.get(name, default)
    )
    provider = UpstashMemoryProvider()
    provider.initialize("s", platform="cli")
    assert created["allow_telemetry"] is expected
    tagged = "upstash-hermes-memory@" in provider._redis._headers.get("Upstash-Telemetry-Sdk", "")
    assert tagged is expected


def _turns(*texts):
    out = []
    for user, assistant in texts:
        out += [{"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
    return out


def _stamped(*texts, start=1000.0):
    """A Hermes history: each user message carries the timestamp Hermes gives it."""
    out = []
    for n, (user, assistant) in enumerate(texts):
        out += [
            {"role": "user", "content": user, "timestamp": start + n},
            {"role": "assistant", "content": assistant},
        ]
    return out


def _saved(history):
    """The transcript sync_turn saves for that history: user turns keep their stamp as `ts`."""
    return [
        {
            "role": m["role"],
            "content": m["content"],
            **({"ts": m["timestamp"]} if "timestamp" in m else {}),
        }
        for m in history
    ]


def test_rewind_by_time_tells_identical_turns_apart():
    history = _stamped(("yes", "okay"), ("yes", "okay"))
    saved = _saved(history)
    # /undo of the second exchange: Hermes keeps only the first one.
    assert rewind_transcript(saved, history[:2]) == saved[:2]
    assert rewind_transcript(saved, []) == []


def test_rewind_by_time_keeps_turns_compaction_summarized():
    history = _stamped(
        ("opening goal", "a"), ("yes", "b"), ("middle", "c"), ("yes", "d"), ("undo this", "e")
    )
    saved = _saved(history)
    # In-place compaction left a summary plus the latest "yes"; then the last turn was undone.
    compacted = [{"role": "user", "content": "[summary]", "timestamp": 1003.5}, *history[6:8]]
    assert rewind_transcript(saved, compacted) == saved[:8]


def test_sync_turn_stamps_each_saved_turn(provider):
    provider.sync_turn("hi", "hello", session_id="s-ts", messages=_stamped(("hi", "hello")))
    doc = provider._chats.get_chat("s-ts", user_id="arda")
    assert doc["messages"][0]["ts"] == 1000.0


def test_undo_of_an_identical_turn_removes_it_from_redis(provider):
    both = _stamped(("yes", "okay"), ("yes", "okay"))
    provider.sync_turn("yes", "okay", session_id="s-dup", messages=both[:2])
    provider.sync_turn("yes", "okay", session_id="s-dup", messages=both)
    provider.on_session_switch("s-dup", rewound=True)
    provider.on_session_end(both[:2])  # exit right after /undo
    doc = provider._chats.get_chat("s-dup", user_id="arda")
    assert [m["content"] for m in doc["messages"]] == ["yes", "okay"]


def test_rewind_by_time_accepts_stamps_redis_returned_as_ints():
    # RedisJSON reads `1000.0` back as `1000`; a resumed session's saved turns arrive that way.
    both = _stamped(("yes", "okay"), ("yes", "okay"))
    saved = [{**e, "ts": int(e["ts"])} if "ts" in e else e for e in _saved(both)]
    assert rewind_transcript(saved, both[:2]) == saved[:2]


def test_rewind_drops_the_undone_turns():
    saved = _turns(("a", "1"), ("b", "2"), ("c", "3"))
    after_undo = _turns(("a", "1"), ("b", "2"))
    assert rewind_transcript(saved, after_undo) == _turns(("a", "1"), ("b", "2"))
    assert rewind_transcript(saved, _turns(("a", "1"))) == _turns(("a", "1"))
    assert rewind_transcript(saved, []) == []


def test_rewind_matches_repeated_messages_by_their_reply():
    saved = _turns(("yes", "1"), ("yes", "2"), ("no", "3"))
    assert rewind_transcript(saved, _turns(("yes", "1"))) == _turns(("yes", "1"))
    assert rewind_transcript(saved, _turns(("yes", "1"), ("yes", "2"))) == _turns(
        ("yes", "1"), ("yes", "2")
    )


# In-place compaction keeps the session id: the opening stays, the middle becomes a summary.
_SAVED = _turns(
    ("opening goal", "g"), ("yes", "1"), ("middle details", "m"), ("yes", "2"), ("undo this", "u")
)
_COMPACTED = _turns(("opening goal", "g")) + [
    {"role": "user", "content": "[CONTEXT SUMMARY] the user agreed twice and gave details"},
    {"role": "assistant", "content": "noted"},
    *_turns(("yes", "2")),
]


def test_rewind_after_in_place_compaction_keeps_the_retained_turns():
    assert rewind_transcript(_SAVED, _COMPACTED) == _SAVED[:8]


def test_undo_after_in_place_compaction_then_a_new_turn(provider):
    for user, reply in zip(_SAVED[::2], _SAVED[1::2]):
        provider.sync_turn(user["content"], reply["content"], session_id="s-compact")
    provider.on_session_switch("s-compact", rewound=True)
    history = _COMPACTED + _turns(("next step", "n"))
    provider.sync_turn("next step", "n", session_id="s-compact", messages=history)
    doc = provider._chats.get_chat("s-compact", user_id="arda")
    assert doc["messages"] == _SAVED[:8] + _turns(("next step", "n"))


def test_undo_after_in_place_compaction_then_exit(provider):
    for user, reply in zip(_SAVED[::2], _SAVED[1::2]):
        provider.sync_turn(user["content"], reply["content"], session_id="s-compact-exit")
    provider.on_session_switch("s-compact-exit", rewound=True)
    provider.on_session_end(_COMPACTED)
    doc = provider._chats.get_chat("s-compact-exit", user_id="arda")
    assert doc["messages"] == _SAVED[:8]


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
