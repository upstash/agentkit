# upstash-hermes-memory

An Upstash Redis memory provider for [Hermes Agent](https://hermes-agent.nousresearch.com), built on
the same Redis Search layout as `@upstash/agentkit-sdk`'s `AgentMemory` and `ChatHistory`. A memory
your AI SDK app saves is recalled by your Hermes agent, and the other way round.

## What it does in Hermes

- **Recall:** before each turn, the memories closest to the user's message are added to the prompt.
- **Chat history:** after each turn, the session's transcript is saved as a searchable document.
- **Mirroring:** facts the built-in `memory` tool adds are also saved to Redis, and when Hermes
  corrects (`replace`/`patch`) or removes one, the Redis copy is updated or deleted too.
- **Tools:** `upstash_memory_save`, `upstash_memory_search`, `upstash_memory_forget` and
  `upstash_chat_search` (search past conversations).

Subagents, cron jobs and context flushes can read memory but never write it.

## Setup

```bash
# into the Python environment Hermes runs in
pip install upstash-hermes-memory
```

Then select it in Hermes's `config.yaml`:

```yaml
memory:
  provider: upstash
```

And give it a database, in your environment or `~/.hermes/.env` (`hermes memory setup` asks for
these):

| Variable | |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Required. From the [Upstash console](https://console.upstash.com/redis). |
| `UPSTASH_HERMES_USER_ID` | Whose memories these are. Defaults to the gateway user, then the Hermes profile name, then `default`. |
| `UPSTASH_HERMES_NAMESPACE` | Key namespace. Default `agentkit`, so memories sit at the TS SDK's default keys and are shared with AgentKit apps on the same database. |

## Telemetry

On by default, like the other Upstash SDKs: requests to your Upstash database carry
`upstash-hermes-memory@<version>` in the `Upstash-Telemetry-Sdk` header, next to the tag
`upstash-redis` already sends. Nothing else is collected and nothing goes anywhere but your
database. Set `UPSTASH_DISABLE_TELEMETRY=1` to turn it off.

## Redis layout

| | Key | Value |
| --- | --- | --- |
| Memory | `agentkit:memory:<user>:<id>` | JSON `{text, userId, createdAt, ...metadata}`, as the TS SDK writes it |
| Chat | `agentkit:chat:<user>:<session>` | JSON `{kind: "chat", userId, sessionId, userMessages, modelMessages, messages, createdAt, updatedAt}` |

Memory and chats share **one** search index, `agentkit`, covering both prefixes, so the provider
works on Upstash's Free plan, which allows one index per database. An AgentKit TS app on the same
database still creates its own memory index, so using both needs a plan with more than one index.

User and session ids are used as they are, so the same id reads the same keys from Hermes and the
TS SDK. Like the TS SDK, the provider refuses a user id with `:` (the key separator), and keeps no
transcript for a session id with one. Indexes are created on first use. `AgentMemory` and `ChatHistory` are importable on their own for
use outside Hermes.

## Development

```bash
uv sync --all-packages && pnpm py:lint && pnpm py:test   # Redis tests need UPSTASH_REDIS_REST_* set
uv run python python/hermes-memory/e2e/hermes_e2e.py     # a real Hermes session, needs OPENAI_API_KEY
```

The e2e script installs the package into a temporary directory and runs Hermes with a temporary
`HERMES_HOME`, so your own Hermes install is not touched. Hermes's built-in memory is turned off
there. One session saves two facts; a fresh session started right after must name them without
calling any tool (checked in Hermes's `state.db`), so they can only come from the automatic recall;
and a control session as another user must not know them. The script then checks the keys and
transcripts in Redis (and, if `packages/sdk` is built, that the TS `AgentMemory` recalls them too)
before cleaning up.
