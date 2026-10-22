import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[3]


def _load_root_env() -> None:
    """Load the repo-root `.env` like the TS tests do (dotenv in test-support.ts).

    Variables already in the environment win, so CI's secrets are never overridden. Without the
    file and without the variables, the Redis tests skip themselves as before.
    """
    path = REPO_ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_root_env()


@pytest.fixture
def redis():
    """A client for the shared test Redis, or a skip when CI has no secrets (fork PRs)."""
    if not (
        os.environ.get("UPSTASH_REDIS_REST_URL") and os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    ):
        pytest.skip("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set")
    from upstash_redis import Redis

    return Redis.from_env()
