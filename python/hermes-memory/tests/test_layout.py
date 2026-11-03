"""The Redis layout must stay byte-compatible with the TS SDK (packages/sdk/src)."""

from upstash_hermes_memory import AgentMemory, ChatHistory
from upstash_hermes_memory._search import dumps, index_name_for
from upstash_hermes_memory._telemetry import SDK_TELEMETRY, add_telemetry
from upstash_hermes_memory.chat_history import extract_text


class Recorder:
    def __init__(self):
        self.commands = []
        self._headers = {"Upstash-Telemetry-Sdk": "py-upstash-redis@v1.8.0"}

    def execute(self, command):
        self.commands.append(command)
        return True

    def expire(self, key, seconds):
        self.commands.append(["EXPIRE", key, seconds])
        return True


def test_index_names_follow_the_ts_default():
    assert index_name_for("agentkit:memory") == "agentkit_memory"
    assert index_name_for("agentkit:chat") == "agentkit_chat"
    assert index_name_for("my-app.mem:v2") == "my_app_mem_v2"


SHARED_CREATE = (
    "SEARCH.CREATE agentkit EXISTSOK ON JSON PREFIX 2 agentkit:memory: agentkit:chat: SCHEMA "
    "kind TEXT NOTOKENIZE userId TEXT NOTOKENIZE text TEXT sessionId TEXT NOTOKENIZE "
    "userMessages TEXT modelMessages TEXT"
)


def test_memory_and_chats_share_one_index_by_default():
    # Upstash's Free plan allows one search index per database.
    memory = AgentMemory(Recorder(), enable_telemetry=False)
    chats = ChatHistory(Recorder(), enable_telemetry=False)
    assert " ".join(memory.index.create_command()) == SHARED_CREATE
    assert " ".join(chats.index.create_command()) == SHARED_CREATE


def test_a_prefix_gives_a_store_its_own_index_like_the_ts_sdk():
    memory = AgentMemory(Recorder(), prefix="agentkit:memory", enable_telemetry=False)
    assert " ".join(memory.index.create_command()) == (
        "SEARCH.CREATE agentkit_memory EXISTSOK ON JSON PREFIX 1 agentkit:memory: "
        "SCHEMA text TEXT userId TEXT NOTOKENIZE"
    )
    chats = ChatHistory(Recorder(), prefix="agentkit:chat", enable_telemetry=False)
    assert " ".join(chats.index.create_command()) == (
        "SEARCH.CREATE agentkit_chat EXISTSOK ON JSON PREFIX 1 agentkit:chat: SCHEMA "
        "userId TEXT NOTOKENIZE sessionId TEXT NOTOKENIZE userMessages TEXT modelMessages TEXT"
    )


def test_chats_are_tagged_and_memories_keep_the_ts_shape():
    redis = Recorder()
    ChatHistory(redis, enable_telemetry=False).save_chat("s1", [], user_id="u1")
    (_get, chat_set) = redis.commands
    assert chat_set[1] == "agentkit:chat:u1:s1"
    assert chat_set[3].startswith('{"kind":"chat","userId":"u1"')


def test_memory_document_matches_agent_memory():
    redis = Recorder()
    record = AgentMemory(redis, enable_telemetry=False).add("likes tea", user_id="u1", id="m1")
    (command,) = redis.commands
    assert command[:3] == ["JSON.SET", "agentkit:memory:u1:m1", "$"]
    assert command[3] == f'{{"text":"likes tea","userId":"u1","createdAt":{record.created_at}}}'


def test_json_is_written_like_json_stringify():
    assert dumps({"a": "çay", "b": [1, None]}) == '{"a":"çay","b":[1,null]}'


def test_extract_text_matches_the_ts_default_extractor():
    text = extract_text(
        [
            {"role": "user", "content": " hi "},
            {"role": "assistant", "parts": [{"type": "text", "text": "hello"}, {"type": "tool"}]},
            {"role": "tool", "content": "ignored"},
            {"role": "model", "content": "again"},
            {"role": "user", "content": "   "},
        ]
    )
    assert text == {"userMessages": "hi", "modelMessages": "hello\nagain"}


def test_ids_with_colons_are_refused():
    memory = AgentMemory(Recorder(), enable_telemetry=False)
    for bad in ("", "a:b"):
        try:
            memory.add("x", user_id=bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted user_id {bad!r}")


def test_telemetry_tags_the_client_once(monkeypatch):
    monkeypatch.delenv("UPSTASH_DISABLE_TELEMETRY", raising=False)
    redis = Recorder()
    AgentMemory(redis)
    ChatHistory(redis)
    assert redis._headers["Upstash-Telemetry-Sdk"] == f"py-upstash-redis@v1.8.0,{SDK_TELEMETRY}"


def test_telemetry_opt_outs(monkeypatch):
    redis = Recorder()
    add_telemetry(redis, enabled=False)
    monkeypatch.setenv("UPSTASH_DISABLE_TELEMETRY", "1")
    add_telemetry(redis)
    assert redis._headers["Upstash-Telemetry-Sdk"] == "py-upstash-redis@v1.8.0"


def test_chat_ttl_is_applied_whenever_set_like_the_ts_sdk():
    # TS ChatHistory sends EXPIRE when ttlSeconds is defined, so 0 expires the chat at once.
    for ttl, expected in ((None, []), (0, [0]), (3600, [3600])):
        redis = Recorder()
        ChatHistory(redis, ttl_seconds=ttl, enable_telemetry=False).save_chat(
            "s1", [{"role": "user", "content": "hi"}], user_id="u1"
        )
        assert [c[2] for c in redis.commands if c[0] == "EXPIRE"] == expected
