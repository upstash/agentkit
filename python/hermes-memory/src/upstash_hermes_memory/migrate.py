"""Switch a namespace's shared search index between keyword and hybrid (semantic) recall.

    python -m upstash_hermes_memory.migrate --to hybrid     # add embeddings to memory `text`
    python -m upstash_hermes_memory.migrate --to keyword    # back to the 0.2.x index (rollback)

Stop every client of the namespace first (the Hermes gateway, the desktop app, cron jobs, other
profiles on the same namespace): the index is dropped and created again, so searches fail in
between, and a client that recreates the index during the gap would race this script. Documents
are never touched; only the index is rebuilt over the same keys, then checked against the counts
it had before. Running it again is safe: an index that is already the target is left alone.

Credentials come from UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in the environment, or
from `--env-file` (e.g. ~/.hermes/.env), which is read for those keys and the namespace only.
"""

import argparse
import os
import sys
import time
from typing import Any

from ._search import (
    DEFAULT_NAMESPACE,
    SHARED_SCHEMA,
    SearchIndex,
    describe,
    dumps,
    index_name_for,
    matches,
    with_hybrid_text,
)

_KEYS = ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "UPSTASH_HERMES_NAMESPACE")
_CHATS = {"kind": {"$eq": "chat"}}
_MEMORIES = {"$mustNot": [{"kind": {"$eq": "chat"}}]}


class MigrationError(Exception):
    pass


def _read_env_file(path: str) -> dict[str, str]:
    values: dict[str, str] = {}
    with open(path) as file:
        for line in file:
            line = line.strip().removeprefix("export ").strip()
            key, sep, value = line.partition("=")
            if sep and key.strip() in _KEYS:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    return values


def _counts(redis: Any, name: str) -> tuple[int, int]:
    """(memories, chats) the index holds; -1 each when the index does not exist."""

    def count(filter: dict[str, Any]) -> int:
        result = redis.execute(["SEARCH.COUNT", name, dumps(filter)])
        return int(getattr(result, "count", result))

    return count(_MEMORIES), count(_CHATS)


def migrate(
    redis: Any,
    *,
    namespace: str,
    to: str,
    confirm: Any = lambda plan: True,
    log: Any = print,
    attempts: int = 3,
) -> str:
    """Rebuild the shared index of `namespace` as `to` ("hybrid" or "keyword").

    Returns "unchanged", "created" or "migrated". Raises MigrationError, without dropping anything,
    when the live index is not one this package created, and after a failed rebuild with the
    command that recovers it.
    """
    if to not in ("hybrid", "keyword"):
        raise ValueError("to must be 'hybrid' or 'keyword'")
    keyword, hybrid = list(SHARED_SCHEMA), with_hybrid_text(SHARED_SCHEMA)
    target, other = (hybrid, keyword) if to == "hybrid" else (keyword, hybrid)
    name = index_name_for(namespace)
    prefixes = [f"{namespace}:memory:", f"{namespace}:chat:"]
    index = SearchIndex(redis, name=name, prefix=prefixes, schema=target)

    current = describe(redis, name)
    if matches(current, prefixes, target):
        log(f"Index {name} is already {to}; nothing to do.")
        return "unchanged"
    if current is None:
        if not confirm(f"Index {name} does not exist. Create it as {to}?"):
            raise MigrationError("cancelled")
        _create(redis, index, prefixes, target, attempts, log)
        log(f"Created index {name} ({to}).")
        return "created"
    if not matches(current, prefixes, other):
        raise MigrationError(
            f"Index {name} has a definition this package did not create ({current}); "
            "refusing to drop it."
        )

    memories, chats = _counts(redis, name)
    came_from = "keyword" if to == "hybrid" else "hybrid"
    plan = (
        f"Rebuild index {name} from {came_from} to {to}: {memories} memories and {chats} chats "
        f"will be indexed again{' and embedded' if to == 'hybrid' else ''}. Documents are not "
        "touched. Every client of this namespace must be stopped. Continue?"
    )
    if not confirm(plan):
        raise MigrationError("cancelled")

    redis.execute(["SEARCH.DROP", name])
    try:
        _create(redis, index, prefixes, target, attempts, log)
    except MigrationError as error:
        raise MigrationError(
            f"{error}. The index is gone and searches fail until it exists again; documents are "
            f"intact. Re-run this command (--to {to}), or restore the previous index with "
            f"--to {came_from}."
        ) from error

    after = _counts(redis, name)
    if after != (memories, chats):
        raise MigrationError(
            f"Index {name} is {to} now, but holds {after[0]} memories and {after[1]} chats "
            f"(before: {memories} and {chats}). Was a client still writing? Check, then restart."
        )
    log(f"Index {name} is {to}: {memories} memories and {chats} chats indexed.")
    return "migrated"


def _create(
    redis: Any, index: SearchIndex, prefixes: list[str], target: list, attempts: int, log: Any
) -> None:
    """CREATE then WAITINDEXING, retried; reconciles with DESCRIBE after an ambiguous failure."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            redis.execute(index.create_command())
        except Exception as error:  # noqa: BLE001 - a timeout may still have created it
            last = error
            log(f"Create attempt {attempt} failed: {error}")
        found = describe(redis, index.name)
        if matches(found, prefixes, target):
            # 1 once every document is searchable; 0 means the index is missing (dropped again).
            if redis.execute(["SEARCH.WAITINDEXING", index.name]) == 1:
                return
            last = MigrationError(f"index {index.name} disappeared while indexing")
        elif found is not None:
            raise MigrationError(f"index {index.name} was created with another definition: {found}")
        time.sleep(min(2**attempt, 10))
    raise MigrationError(f"could not create index {index.name}: {last}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m upstash_hermes_memory.migrate",
        description="Switch the shared memory/chat index between keyword and hybrid recall.",
    )
    parser.add_argument("--to", required=True, choices=["hybrid", "keyword"])
    parser.add_argument("--namespace", help=f"key namespace (default: {DEFAULT_NAMESPACE})")
    parser.add_argument("--env-file", help="read the Upstash credentials from this .env file")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    args = parser.parse_args(argv)

    env = {k: os.environ[k] for k in _KEYS if os.environ.get(k)}
    if args.env_file:
        env.update(_read_env_file(args.env_file))
    if not (env.get("UPSTASH_REDIS_REST_URL") and env.get("UPSTASH_REDIS_REST_TOKEN")):
        print("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.", file=sys.stderr)
        return 2
    namespace = args.namespace or env.get("UPSTASH_HERMES_NAMESPACE") or DEFAULT_NAMESPACE

    from upstash_redis import Redis

    redis = Redis(
        url=env["UPSTASH_REDIS_REST_URL"],
        token=env["UPSTASH_REDIS_REST_TOKEN"],
        allow_telemetry=False,
    )

    def confirm(plan: str) -> bool:
        print(plan)
        if args.yes:
            return True
        if not sys.stdin.isatty():
            print("Not a terminal: pass --yes to confirm.", file=sys.stderr)
            return False
        return input("Type yes to continue: ").strip().lower() == "yes"

    try:
        migrate(redis, namespace=namespace, to=args.to, confirm=confirm)
    except MigrationError as error:
        print(f"Migration stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
