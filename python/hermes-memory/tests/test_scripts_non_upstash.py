"""Lua scripts against a Redis server other than Upstash (Redis or Valkey behind SRH, see the
`non-upstash` CI job). Runs only when NON_UPSTASH_REDIS_REST_URL / _TOKEN are set."""

import os
import uuid

import pytest
from upstash_hermes_memory import _scripts
from upstash_hermes_memory._scripts import build_script, eval_script

URL = os.environ.get("NON_UPSTASH_REDIS_REST_URL")
TOKEN = os.environ.get("NON_UPSTASH_REDIS_REST_TOKEN")

pytestmark = pytest.mark.skipif(not (URL and TOKEN), reason="no non-Upstash Redis configured")

INCR = 'return redis.call("INCR", KEYS[1])'


class Recording:
    """A fresh client to the server, recording the script of every EVAL sent through it."""

    def __init__(self):
        from upstash_redis import Redis

        self.client = Redis(url=URL, token=TOKEN)
        self.scripts = []

    def execute(self, command):
        if command[0] == "EVAL":
            self.scripts.append(command[1])
        return self.client.execute(command)


@pytest.fixture
def key():
    return f"test:hermes:nonUpstash:{uuid.uuid4().hex}"


@pytest.fixture(autouse=True)
def reset_warning(monkeypatch):
    monkeypatch.setattr(_scripts, "_warned", False)


def test_unset_sends_the_flags_once_then_runs_without_them(key):
    redis = Recording()
    run = lambda: eval_script(redis, "chat_append", INCR, [key], [], enable_telemetry=True)
    assert run() == 1
    assert run() == 2
    named = build_script("chat_append", INCR, with_flags=True, with_name=True)
    assert redis.scripts == [named, INCR, INCR]


def test_false_never_sends_the_flags(key):
    redis = Recording()
    assert (
        eval_script(redis, "chat_append", INCR, [key], [], enable_upstash_script_flags=False) == 1
    )
    assert redis.scripts == [INCR]


def test_true_raises_even_on_a_client_that_fell_back_before(key):
    redis = Recording()
    eval_script(redis, "chat_append", INCR, [key], [])  # falls back
    with pytest.raises(Exception, match="shebang|near '#'"):
        eval_script(redis, "chat_append", INCR, [key], [], enable_upstash_script_flags=True)
