"""End-to-end check of the provider inside a real Hermes Agent, against a real Upstash Redis.

    uv run python python/hermes-memory/e2e/hermes_e2e.py [--keep] [--model gpt-5-mini]

What it does:
1. Builds the wheel and installs it (plus upstash-redis) into a temporary directory that is put on
   Hermes's PYTHONPATH. Hermes's own install and ~/.hermes are not touched: Hermes runs with a
   temporary HERMES_HOME whose config.yaml selects `memory.provider: upstash`.
2. Session 1 asks the agent to remember two facts. Session 2, a fresh session started right away,
   asks for them back. Hermes's built-in memory is off, and session 2 must answer without calling
   a tool (read from Hermes's state.db), so the facts can only come from the provider's automatic
   recall. A control session as another user must not know them.
3. Checks Redis: the memories and both transcripts landed under a unique prefix, in the documents
   and indexes the TS SDK uses. If packages/sdk is built, the TS AgentMemory recalls the same
   memory too.
4. Drops the e2e indexes and deletes the keys (unless --keep).

Needs: Hermes installed (`hermes` on PATH), UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN and
OPENAI_API_KEY in the environment or the repo's .env.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PACKAGE = REPO / "python" / "hermes-memory"
USER_ID = "e2e-user"
FACT_PROMPT = (
    "Please remember this for future conversations: my cat is called Pamuk and my favourite "
    "programming language is Elixir. Save it to your long-term memory."
)
RECALL_PROMPT = (
    "What is my cat called, and what is my favourite programming language? "
    "Answer from what you remember about me, in one sentence."
)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"'))


def hermes_python() -> list[str]:
    """Hermes's own interpreter and entry script. Its launcher unsets PYTHONPATH, so skip it."""
    launcher = shutil.which("hermes")
    if not launcher:
        sys.exit("hermes is not on PATH: install Hermes Agent first")
    home = Path(os.environ.get("HERMES_INSTALL_DIR", Path.home() / ".hermes" / "hermes-agent"))
    python, script = home / "venv" / "bin" / "python", home / "hermes"
    if not (python.exists() and script.exists()):
        sys.exit(f"cannot find Hermes's venv under {home} (set HERMES_INSTALL_DIR)")
    return [str(python), str(script)]


def step(title: str) -> None:
    print(f"\n== {title} ==", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="gpt-5-mini")
    parser.add_argument("--keep", action="store_true", help="leave the keys and indexes in Redis")
    args = parser.parse_args()

    load_dotenv(REPO / ".env")
    for name in ("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "OPENAI_API_KEY"):
        if not os.environ.get(name):
            sys.exit(f"{name} is not set")

    from upstash_hermes_memory import AgentMemory, ChatHistory
    from upstash_redis import Redis

    run = uuid.uuid4().hex[:8]
    memory_prefix, chat_prefix = f"e2e:hermes:{run}:memory", f"e2e:hermes:{run}:chat"
    redis = Redis.from_env()
    memory = AgentMemory(redis, prefix=memory_prefix, enable_telemetry=False)
    chats = ChatHistory(redis, prefix=chat_prefix, enable_telemetry=False)
    work = Path(tempfile.mkdtemp(prefix="hermes-e2e-"))
    failures: list[str] = []

    def check(ok: bool, what: str) -> None:
        print(f"  {'ok  ' if ok else 'FAIL'} {what}")
        if not ok:
            failures.append(what)

    try:
        step("install the provider next to Hermes (temporary)")
        dist, site, home = work / "dist", work / "site", work / "home"
        subprocess.run(
            ["uv", "build", "--wheel", "--package", "upstash-hermes-memory", "--out-dir", dist],
            cwd=REPO,
            check=True,
            capture_output=True,
        )
        (wheel,) = dist.glob("*.whl")
        # --no-deps: httpx and friends come from Hermes's venv, only upstash-redis is missing there.
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--quiet",
                "--no-deps",
                "--target",
                site,
                wheel,
                "upstash-redis==1.8.0",
            ],
            check=True,
        )
        home.mkdir()
        # Hermes's own stores (MEMORY.md / USER.md) default to on. Off, they cannot carry the
        # facts from session 1 to session 2: the provider is the only way across.
        (home / "config.yaml").write_text(
            f"model:\n  provider: openai-api\n  default: {args.model}\n"
            "memory:\n  provider: upstash\n  memory_enabled: false\n  user_profile_enabled: false\n"
        )
        env = {
            **os.environ,
            "HERMES_HOME": str(home),
            "PYTHONPATH": str(site),
            "UPSTASH_HERMES_MEMORY_PREFIX": memory_prefix,
            "UPSTASH_HERMES_CHAT_PREFIX": chat_prefix,
        }
        print(f"  HERMES_HOME={home}\n  prefixes {memory_prefix} / {chat_prefix}")

        def hermes(prompt: str, user: str = USER_ID) -> tuple[str, list[str]]:
            """Run one fresh one-shot session; return its answer and the tools it called."""
            cmd = [*hermes_python(), "-z", prompt, "--provider", "openai-api", "-m", args.model]
            done = subprocess.run(
                cmd,
                check=False,
                env={**env, "UPSTASH_HERMES_USER_ID": user},
                capture_output=True,
                text=True,
                timeout=300,
            )
            if done.returncode != 0:
                print(done.stdout, done.stderr, sep="\n")
                raise SystemExit(f"hermes exited with {done.returncode}")
            # Hermes records every session in $HERMES_HOME/state.db, tool results included.
            with sqlite3.connect(home / "state.db") as db:
                (session,) = db.execute(
                    "SELECT session_id FROM messages WHERE role = 'user' AND content = ?"
                    " ORDER BY id DESC LIMIT 1",
                    (prompt,),
                ).fetchone()
                tools = [
                    row[0]
                    for row in db.execute(
                        "SELECT tool_name FROM messages WHERE session_id = ? AND role = 'tool'"
                        " ORDER BY id",
                        (session,),
                    )
                ]
            answer = done.stdout.strip()
            print("  < " + answer.replace("\n", "\n    "))
            print(f"  tools called: {tools or 'none'}")
            return answer, tools

        # The sessions run back to back, with no waiting in between: a fact the agent saved must
        # be recallable as soon as the save tool returns.
        step("session 1: tell the agent two facts")
        print("  > " + FACT_PROMPT)
        _, tools_1 = hermes(FACT_PROMPT)
        check(
            tools_1.count("upstash_memory_save") >= 1, "session 1 saved through upstash_memory_save"
        )
        check("memory" not in tools_1, "session 1 did not use Hermes's built-in memory tool")

        step("session 2: a fresh session asks for them back")
        print("  > " + RECALL_PROMPT)
        answer, tools_2 = hermes(RECALL_PROMPT)
        check("Pamuk" in answer, "the answer names the cat (Pamuk)")
        check("Elixir" in answer, "the answer names the language (Elixir)")
        # With no tool calls, the facts can only have come from the automatic recall (prefetch).
        check(tools_2 == [], "session 2 called no tools: the facts came from automatic recall")

        step("control: the same question as a user with no memories")
        print("  > " + RECALL_PROMPT)
        control, _ = hermes(RECALL_PROMPT, user=f"{USER_ID}-control")
        check("Pamuk" not in control, "another user's session does not know the cat's name")

        step("Hermes's built-in stores stayed empty")
        builtin = [
            p for p in (home / "memories").glob("*") if p.is_file() and p.read_text().strip()
        ]
        print(f"  {home / 'memories'}: {[p.name for p in builtin] or 'empty'}")
        check(not builtin, "MEMORY.md / USER.md hold nothing")

        step("Redis: memories")
        memory.index.wait_indexing()
        saved = memory.list(user_id=USER_ID)
        for record in saved:
            print(
                f"  memory {memory_prefix}:{USER_ID}:{record.id} -> {record.text!r} {record.metadata}"
            )
        text = " ".join(r.text for r in saved)
        check("Pamuk" in text, "a memory mentioning Pamuk was saved")
        check("Elixir" in text, "a memory mentioning Elixir was saved")

        step("Redis: chat history")
        chats.index.wait_indexing()
        sessions = chats.list_chats(user_id=USER_ID)
        for doc in sessions:
            roles = [m["role"] for m in doc["messages"]]
            print(f"  chat {chat_prefix}:{USER_ID}:{doc['sessionId']} messages={roles}")
        check(len(sessions) == 2, "both sessions were saved as transcripts")
        check(
            any("Pamuk" in d.get("userMessages", "") for d in sessions),
            "session 1's transcript holds the user's message",
        )
        hits = chats.search_chats("cat Pamuk", user_id=USER_ID)
        check(bool(hits), "the transcripts are searchable (search_chats 'cat Pamuk')")

        step("Redis: layout shared with the TS SDK")
        key = f"{memory_prefix}:{USER_ID}:{saved[0].id}" if saved else ""
        doc = redis.execute(["JSON.GET", key]) if key else None
        print(f"  JSON.GET {key} -> {json.dumps(doc)}")
        check(
            isinstance(doc, dict) and {"text", "userId", "createdAt"} <= set(doc),
            "memory documents have the AgentMemory shape",
        )
        ts_dist = REPO / "packages" / "sdk" / "dist" / "index.js"
        if ts_dist.exists() and shutil.which("node"):
            script = (
                "const { AgentMemory } = await import(process.argv[1]);"
                "const { Redis } = await import('@upstash/redis');"
                "const m = new AgentMemory({ redis: Redis.fromEnv(), prefix: process.argv[2],"
                " enableTelemetry: false });"
                "const hits = await m.recall({ query: 'cat Pamuk', userId: process.argv[3] });"
                "console.log(JSON.stringify(hits.map((h) => h.text)));"
            )
            out = subprocess.run(
                ["node", "--input-type=module", "-e", script, str(ts_dist), memory_prefix, USER_ID],
                check=False,
                cwd=REPO / "packages" / "sdk",
                capture_output=True,
                text=True,
            )
            print(f"  TS AgentMemory.recall -> {out.stdout.strip() or out.stderr.strip()[:300]}")
            check("Pamuk" in out.stdout, "the TS SDK recalls the memory Hermes saved")
        else:
            print("  (skipped: build packages/sdk to cross-check with the TS SDK)")
    finally:
        if args.keep:
            print(
                f"\n--keep: left {memory_prefix}* and {chat_prefix}* in Redis, HERMES_HOME {work}"
            )
        else:
            for index in (memory.index, chats.index):
                try:
                    index.drop()
                except Exception as error:  # noqa: BLE001 - cleanup is best effort
                    print(f"  could not drop {index.name}: {error}")
            for prefix in (memory_prefix, chat_prefix):
                cursor = 0
                while True:
                    cursor, keys = redis.scan(cursor, match=f"{prefix}*", count=200)
                    if keys:
                        redis.delete(*keys)
                    if int(cursor) == 0:
                        break
            shutil.rmtree(work, ignore_errors=True)

    print(f"\n{'E2E PASSED' if not failures else 'E2E FAILED: ' + '; '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    start = time.monotonic()
    try:
        main()
    finally:
        print(f"({time.monotonic() - start:.0f}s)")
