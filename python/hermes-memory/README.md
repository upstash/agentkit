# upstash-hermes-memory

An Upstash Redis memory provider for [Hermes Agent](https://hermes-agent.nousresearch.com), built on
the same Redis Search layout as `@upstash/agentkit-sdk`'s `AgentMemory` and `ChatHistory`. A memory
your AI SDK app saves is recalled by your Hermes agent, and the other way round.

## What it does in Hermes

- **Recall:** before each turn, the memories closest to the user's message are added to the prompt.
  By keyword and by meaning; see [Semantic recall](#semantic-recall).
- **Chat history:** after each turn, the turn is appended in place to the session's searchable
  transcript document, so a write stays the size of one turn however long the session runs.
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
| `UPSTASH_HERMES_TELEMETRY` | Set to `1` to send telemetry. Off by default; see [Telemetry](#telemetry). |

## Semantic recall

Keyword recall (`$smart`: phrase, term and fuzzy matching) only finds a memory that shares words
with the message: "where is the assistant hosted" misses "Hermes runs on the ops Box". So the
memory `text` field is a `HYBRID` field, which Upstash Redis Search embeds itself (no separate
vector database), and recall merges a keyword query with a semantic `$ann` query using `$rrf`
([Hybrid Search](https://upstash.com/docs/redis/search/hybrid-search)).

- **Upgrading from 0.2.x:** the old index has `text` as `TEXT` and is not supported. Recall fails
  until you replace it: stop every client of the namespace (Hermes gateway, desktop app, cron jobs,
  other profiles on it) and run `SEARCH.DROP agentkit` (or your namespace's index). Your memories
  and chats are kept, and the next start creates the new index and indexes them again.
- Automatic recall injects up to **3** memories: the semantic side has no relevance
  threshold and returns up to its limit even for unrelated text, and in a small-store test its
  similarity scores did not separate related from unrelated memories well enough for a cutoff. `upstash_memory_search` keeps its limit.
- Results carry `retrieval: "hybrid"` or `"keyword"`. Hybrid scores are rank-fusion values that
  only order one search's results; `min_score` applies to keyword results only.
- If a hybrid query fails, recall falls back to keyword search for that call (logged at most
  every 10 minutes).
- Chat history stays keyword-only: a `HYBRID` field gets one embedding for its whole value, and a
  chat document holds a whole session.
- Every memory in the index is embedded, whichever user or profile wrote it, and each recall
  sends the message to Upstash Redis Search to be embedded. In a small-store test a hybrid query
  took about 150 to 300 ms, against a few ms for keyword recall.

## Telemetry

Off by default. Set `UPSTASH_HERMES_TELEMETRY=1` to opt in: requests to your Upstash database then
carry `upstash-hermes-memory@<version>` in the `Upstash-Telemetry-Sdk` header, next to the
`upstash-redis` client's own telemetry headers (SDK version, Python version, platform). Nothing
else is collected and nothing goes anywhere but your database. Without the opt-in the provider
creates its Redis client with `allow_telemetry=False`, so none of these headers are sent.
`UPSTASH_DISABLE_TELEMETRY=1` turns telemetry off even when opted in.

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
