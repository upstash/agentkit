"""Switch a namespace's shared search index between keyword and hybrid (semantic) recall.

    python -m upstash_hermes_memory.migrate --to hybrid     # add embeddings to memory `text`
    python -m upstash_hermes_memory.migrate --to keyword    # back to the 0.2.x index (rollback)

Stop every client of the namespace first (the Hermes gateway, the desktop app, cron jobs, other
profiles on the same namespace): the index is dropped and created again, so searches fail in
between, and a client that recreates the index during the gap would race this script. Documents
are never touched; only the index is rebuilt over the same keys.

Before dropping anything the script waits for pending indexing, then saves what the index holds
(memory and chat counts and a sample of memory keys) at `<namespace>:migrate:baseline`. After the
rebuild it checks the new index against that baseline and deletes it. If a run is interrupted,
running the same command again resumes: it finishes the rebuild and checks the saved baseline.

Credentials come from UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in the environment (and the
namespace from UPSTASH_HERMES_NAMESPACE or --namespace); the script reads no files.
"""

import argparse
import json
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

_CHATS = {"kind": {"$eq": "chat"}}
_MEMORIES = {"$mustNot": [{"kind": {"$eq": "chat"}}]}
_SAMPLE = 200  # memory keys checked one by one after the rebuild
_PAGE = 1000  # SEARCH.QUERY's largest LIMIT
_MAX_OFFSET = 10_000  # and its largest OFFSET


class MigrationError(Exception):
    pass


def _counts(redis: Any, name: str) -> tuple[int, int]:
    """(memories, chats) the index holds; -1 each when the index does not exist."""

    def count(filter: dict[str, Any]) -> int:
        result = redis.execute(["SEARCH.COUNT", name, dumps(filter)])
        return int(getattr(result, "count", result))

    return count(_MEMORIES), count(_CHATS)


def _memory_keys(redis: Any, name: str, limit: int, offset: int = 0) -> list[str]:
    cmd = ["SEARCH.QUERY", name, dumps(_MEMORIES), "LIMIT", str(limit), "NOCONTENT"]
    if offset:
        cmd += ["OFFSET", str(offset)]
    rows = redis.execute(cmd) or []
    return [getattr(row, "key", None) or row[0] for row in rows]


def _state(redis: Any, name: str, prefixes: list[str], schemas: dict[str, list]) -> str:
    """ "absent", the matching schema's name, "other", or "unknown" (DESCRIBE failed)."""
    try:
        found = describe(redis, name)
    except Exception:  # noqa: BLE001 - reported, never acted on
        return "unknown"
    if found is None:
        return "absent"
    return next((k for k, s in schemas.items() if matches(found, prefixes, s, name)), "other")


def _wait(redis: Any, name: str) -> None:
    # 1 once every pending update is searchable; 0 means the index does not exist.
    if redis.execute(["SEARCH.WAITINDEXING", name]) != 1:
        raise MigrationError(f"index {name} was not found while waiting for indexing")


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

    Returns "unchanged", "created", "migrated" or "resumed". Raises MigrationError, without
    dropping anything, when the live index is not one this package created (or is an alias), and
    after a failed step, saying what state the index is in.
    """
    if to not in ("hybrid", "keyword"):
        raise ValueError("to must be 'hybrid' or 'keyword'")
    came_from = "keyword" if to == "hybrid" else "hybrid"
    schemas = {"keyword": list(SHARED_SCHEMA), "hybrid": with_hybrid_text(SHARED_SCHEMA)}
    name = index_name_for(namespace)
    prefixes = [f"{namespace}:memory:", f"{namespace}:chat:"]
    index = SearchIndex(redis, name=name, prefix=prefixes, schema=schemas[to])
    baseline_key = f"{namespace}:migrate:baseline"
    raw = redis.execute(["GET", baseline_key])
    baseline = json.loads(raw) if raw else None
    if baseline and to not in (baseline.get("to"), baseline.get("from")):
        raise MigrationError(f"a migration is pending ({baseline_key}): {raw}")
    if baseline and baseline["to"] != to:
        # Rolling an interrupted migration back: same baseline, the other target.
        log(f"Rolling the interrupted migration to {baseline['to']} back to {to}.")
        baseline = {**baseline, "from": baseline["to"], "to": to}
        redis.execute(["SET", baseline_key, dumps(baseline)])

    state = _state(redis, name, prefixes, schemas)
    if state == "unknown":
        raise MigrationError(f"index {name} could not be read; nothing changed")
    if state == "other":
        raise MigrationError(
            f"index {name} is not one this package created (or is an alias); refusing to drop it"
        )

    if state == to:
        _wait(redis, name)
        if baseline:  # a previous run rebuilt the index but did not finish checking it
            _verify(redis, name, baseline, to)
            redis.execute(["DEL", baseline_key])
            log(f"Index {name} is {to}; the interrupted migration is checked and complete.")
            return "resumed"
        memories, chats = _counts(redis, name)
        log(f"Index {name} is already {to} ({memories} memories, {chats} chats); nothing to do.")
        return "unchanged"

    if state == "absent" and not baseline:
        if not confirm(f"Index {name} does not exist. Create it as {to}?"):
            raise MigrationError("cancelled")
        _create(redis, index, prefixes, schemas[to], attempts, log)
        log(f"Created index {name} ({to}).")
        return "created"

    if state == came_from:
        _wait(redis, name)  # pending updates first, or the baseline undercounts
        memories, chats = _counts(redis, name)
        plan = (
            f"Rebuild index {name} from {came_from} to {to}: {memories} memories and {chats} "
            f"chats will be indexed again{' and embedded' if to == 'hybrid' else ''}. Documents "
            "are not touched. Every client of this namespace must be stopped. Continue?"
        )
        if not confirm(plan):
            raise MigrationError("cancelled")
        fresh = baseline is None  # a rollback keeps the baseline of the original index
        if fresh:
            baseline = {
                "from": came_from,
                "to": to,
                "memories": memories,
                "chats": chats,
                "sample": sorted(_memory_keys(redis, name, _SAMPLE)),
                "at": int(time.time()),
            }
            redis.execute(["SET", baseline_key, dumps(baseline)])
        try:
            redis.execute(["SEARCH.DROP", name])
        except Exception as error:  # noqa: BLE001 - reconciled below
            log(f"Drop failed: {error}")
        state = _state(redis, name, prefixes, schemas)
        if state == came_from:
            # Only a baseline taken by this run goes: one from an interrupted migration still
            # describes the documents that rebuild has to account for.
            if fresh:
                redis.execute(["DEL", baseline_key])
            raise MigrationError(f"index {name} could not be dropped; nothing changed")
        if state != "absent":
            raise MigrationError(f"index {name} is {state} after the drop; re-run to resume")
    # Absent with a baseline: just dropped, or an interrupted run stopped between drop and create.
    assert baseline is not None

    try:
        _create(redis, index, prefixes, schemas[to], attempts, log)
    except MigrationError as error:
        now = _state(redis, name, prefixes, schemas)
        raise MigrationError(
            f"{error}. The index is {now}; documents are intact. Re-run this command (--to {to}) "
            f"to resume, or restore the previous index with --to {came_from}."
        ) from error
    _verify(redis, name, baseline, to)
    redis.execute(["DEL", baseline_key])
    log(f"Index {name} is {to}: {baseline['memories']} memories and {baseline['chats']} chats.")
    return "migrated"


def _verify(redis: Any, name: str, baseline: dict[str, Any], to: str) -> None:
    after = _counts(redis, name)
    if after != (baseline["memories"], baseline["chats"]):
        raise MigrationError(
            f"index {name} is {to} now but holds {after[0]} memories and {after[1]} chats "
            f"(before: {baseline['memories']} and {baseline['chats']}). Was a client still "
            "writing? Check, then re-run to verify again."
        )
    missing = set(baseline.get("sample") or [])
    offset, scanned = 0, 0
    while missing and offset <= _MAX_OFFSET:
        page = _memory_keys(redis, name, _PAGE, offset)
        missing -= set(page)
        scanned += len(page)
        if len(page) < _PAGE:
            break
        offset += _PAGE
    # Every memory was listed (the index holds after[0]) or the last page came back short.
    complete = scanned >= after[0] or offset <= _MAX_OFFSET
    if missing and complete:
        raise MigrationError(
            f"index {name} lost {len(missing)} sampled memories, e.g. {min(missing)}"
        )
    # Past OFFSET's limit the remaining sample can't be listed; the counts above still matched.


def _create(
    redis: Any, index: SearchIndex, prefixes: list[str], target: list, attempts: int, log: Any
) -> None:
    """CREATE then WAITINDEXING, retried; reconciles with DESCRIBE after any failed step."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            redis.execute(index.create_command())
        except Exception as error:  # noqa: BLE001 - a timeout may still have created it
            last = error
            log(f"Create attempt {attempt} failed: {error}")
        try:
            found = describe(redis, index.name)
            if matches(found, prefixes, target, index.name):
                _wait(redis, index.name)
                return
            if found is not None:
                raise MigrationError(f"index {index.name} exists with another definition: {found}")
        except MigrationError:
            raise
        except Exception as error:  # noqa: BLE001 - state unknown: retry the whole step
            last = error
            log(f"Checking the index failed: {error}")
        time.sleep(min(2**attempt, 10))
    raise MigrationError(f"could not create index {index.name}: {last}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m upstash_hermes_memory.migrate",
        description="Switch the shared memory/chat index between keyword and hybrid recall.",
    )
    parser.add_argument("--to", required=True, choices=["hybrid", "keyword"])
    parser.add_argument("--namespace", help=f"key namespace (default: {DEFAULT_NAMESPACE})")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    args = parser.parse_args(argv)

    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not (url and token):
        print("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.", file=sys.stderr)
        return 2
    namespace = args.namespace or os.environ.get("UPSTASH_HERMES_NAMESPACE") or DEFAULT_NAMESPACE

    from upstash_redis import Redis

    redis = Redis(url=url, token=token, allow_telemetry=False)

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
    except Exception as error:  # noqa: BLE001 - a clean message instead of a traceback
        print(f"Migration failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
