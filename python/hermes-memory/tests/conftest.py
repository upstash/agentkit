import os

import pytest


@pytest.fixture
def redis():
    """A client for the shared test Redis, or a skip when CI has no secrets (fork PRs)."""
    if not (
        os.environ.get("UPSTASH_REDIS_REST_URL") and os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    ):
        pytest.skip("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set")
    from upstash_redis import Redis

    return Redis.from_env()
