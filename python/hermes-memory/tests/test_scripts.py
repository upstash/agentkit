"""Lua scripts carry Upstash's flags, and fall back without them on servers that reject them."""

import logging

import pytest
from upstash_hermes_memory import _scripts
from upstash_hermes_memory._scripts import build_script, eval_script, is_script_flag_error

INCR = 'return redis.call("INCR", KEYS[1])'


class Recorder:
    """Answers every EVAL with 1 and keeps the scripts it was sent."""

    def __init__(self):
        self.scripts = []

    def execute(self, command):
        self.scripts.append(command[1])
        return 1


class NoShebangServer:
    """Answers EVAL like Redis 7+ / Valkey: a script with a shebang is refused."""

    def __init__(self):
        self.scripts = []

    def execute(self, command):
        assert command[0] == "EVAL"
        self.scripts.append(command[1])
        if command[1].startswith("#!"):
            raise RuntimeError("ERR Unknown lua shebang option: script_name")
        return 1


@pytest.fixture(autouse=True)
def reset_warning(monkeypatch):
    monkeypatch.setattr(_scripts, "_warned", False)
    monkeypatch.delenv("UPSTASH_DISABLE_TELEMETRY", raising=False)


def test_the_script_name_is_only_sent_with_telemetry_on():
    assert build_script("chat_append", INCR, with_flags=True, with_name=True) == (
        "#!lua script_name=agentkit-hermes-memory-py-chat_append flags=allow-key-locking\n" + INCR
    )
    assert build_script("chat_append", INCR, with_flags=True, with_name=False) == (
        "#!lua flags=allow-key-locking\n" + INCR
    )
    assert build_script("chat_append", INCR, with_flags=False, with_name=True) == INCR


def test_eval_script_names_the_script_only_when_telemetry_is_on(monkeypatch):
    server = Recorder()
    eval_script(server, "chat_append", INCR, ["k"], [], enable_telemetry=True)
    eval_script(server, "chat_append", INCR, ["k"], [], enable_telemetry=False)
    monkeypatch.setenv("UPSTASH_DISABLE_TELEMETRY", "1")
    eval_script(server, "chat_append", INCR, ["k"], [], enable_telemetry=True)
    assert [s.split("\n")[0] for s in server.scripts] == [
        "#!lua script_name=agentkit-hermes-memory-py-chat_append flags=allow-key-locking",
        "#!lua flags=allow-key-locking",
        "#!lua flags=allow-key-locking",
    ]


def test_is_script_flag_error():
    assert is_script_flag_error(RuntimeError("ERR Unexpected flag in script shebang: x"))
    assert is_script_flag_error(RuntimeError("ERR user_script:1: unexpected symbol near '#'"))
    assert is_script_flag_error(RuntimeError("ERR Unknown metadata value: script_name=x"))
    assert not is_script_flag_error(RuntimeError("WRONGTYPE Operation against a key"))


def test_unset_falls_back_once_and_remembers(caplog):
    server = NoShebangServer()
    with caplog.at_level(logging.WARNING):
        assert eval_script(server, "chat_append", INCR, ["k"], []) == 1
        assert eval_script(server, "chat_append", INCR, ["k"], []) == 1
    assert server.scripts == [
        build_script("chat_append", INCR, with_flags=True, with_name=False),
        INCR,
        INCR,
    ]
    assert len([r for r in caplog.records if "enable_upstash_script_flags" in r.message]) == 1


def test_false_never_sends_the_flags():
    server = NoShebangServer()
    eval_script(server, "chat_append", INCR, ["k"], [], enable_upstash_script_flags=False)
    assert server.scripts == [INCR]


def test_true_raises_the_rejection():
    with pytest.raises(RuntimeError, match="shebang"):
        eval_script(
            NoShebangServer(), "chat_append", INCR, ["k"], [], enable_upstash_script_flags=True
        )


@pytest.mark.parametrize("telemetry", [True, False])
def test_upstash_redis_accepts_the_flags(redis, prefix, telemetry):
    key = f"{prefix}:incr"
    run = lambda: eval_script(
        redis,
        "test_incr",
        INCR,
        [key],
        [],
        enable_upstash_script_flags=True,
        enable_telemetry=telemetry,
    )
    assert run() == 1
    assert run() == 2
