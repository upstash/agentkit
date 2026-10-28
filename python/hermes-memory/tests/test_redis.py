import uuid


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
