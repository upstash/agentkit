# upstash-hermes-memory

Written by hand: this package is not versioned by Changesets. To release, bump `version` in
`pyproject.toml`, run `node scripts/sync-version.mjs` and `uv lock`, and add a `## <version>`
section here. The release workflow publishes any version PyPI does not have yet.

## 0.3.0

### Minor Changes

- **Breaking:** recall is hybrid only. The memory `text` field is a Redis Search `HYBRID` field and
  recall merges keyword (`$smart`) and semantic (`$ann`) results with `$rrf`. An index from 0.2.x
  (`text` as `TEXT`) is refused with an error: stop every client and run `SEARCH.DROP <index>`.
  Documents are kept and indexed again on the next start. Stores with their own `prefix` change too.
- `AgentMemory.recall` takes `mode="auto"|"keyword"`; records carry `retrieval`. A failed hybrid
  query falls back to keyword once. `min_score` applies to keyword results only.
- Automatic recall injects 3 memories instead of 5.
- `upstash_memory_search` results include `retrieval`.
- Fix: an empty result from a retriever query no longer sends `SEARCH.COUNT` with that query
  (Search rejects `$ann` in COUNT); the missing-index check counts `{}` instead.
- Docs: the shared `agentkit` index is Python-only; the TS SDK creates its own indexes.

## 0.2.2

### Patch Changes

- Chat history appends each turn in place instead of rewriting the whole transcript. A turn used
  to read the saved chat and write it back in full (the messages plus their search text, about
  twice the transcript), so a long-running session sent more on every turn and would stop saving
  once it passed Upstash's 10 MB request limit. `ChatHistory.append_messages` now adds the turn
  with one atomic script (`JSON.ARRAPPEND` / `JSON.STRAPPEND`), and the document ends up exactly
  as a full save would leave it, so the layout stays shared with the TS `ChatHistory`. Only
  `/undo` still reads and rewrites the transcript. A turn (or `/undo`) whose write fails, for
  example on a network blip, stays pending and is written with the next turn or at session end.
- `/undo` cuts by timestamp again for sessions resumed after a restart: Redis returns a
  whole-number stamp such as `1000.0` as `1000`, which made the cut fall back to matching by
  content, so of two identical turns the wrong one could be removed.

## 0.2.1

### Patch Changes

- Telemetry is now opt-in, as the Hermes plugin catalog requires: nothing is tagged unless
  `UPSTASH_HERMES_TELEMETRY=1` is set, and the provider creates its `upstash-redis` client with
  `allow_telemetry=False` too, so it sends none of the client's own telemetry headers either.
  `AgentMemory` and `ChatHistory` default to `enable_telemetry=False`.
- The plugin directory no longer contains a `package.json`, so `hermes plugins install` no longer
  asks to install Node dependencies or prints "Skipped Node deps".

## 0.2.0

### Minor Changes

- 0b64d2d: **Breaking:** memory and chat history now share one Redis Search index (`agentkit`, over `agentkit:memory:` and `agentkit:chat:`), so the provider works on Upstash's Free plan, which allows one index per database. Before, it created two (`agentkit_memory` and `agentkit_chat`) and failed with `ERR Exceeded max index count of 1`. `UPSTASH_HERMES_NAMESPACE` replaces `UPSTASH_HERMES_MEMORY_PREFIX` and `UPSTASH_HERMES_CHAT_PREFIX`. Chats saved before this change are not found by the new index; memories keep their keys and shape and are still shared with AgentKit TS apps.

### Patch Changes

- 0b64d2d: Mirror corrections and removals from the built-in `memory` tool: when Hermes replaces, patches or removes an entry, the copy mirrored to Redis is deleted (and a replace saves the new text), so a corrected or deleted fact is no longer recalled.

## 0.1.1

### Patch Changes

- 7822958: Prepare for the Hermes plugin catalog: add `plugin.yaml` and a directory `__init__.py`, cap
  `upstash-redis` below 2, and document telemetry and how to turn it off.

## 0.1.0

### Minor Changes

- 6269e3b: First release: an Upstash Redis memory provider for Hermes Agent. It recalls related memories into each turn, saves every session as a searchable transcript, mirrors the built-in `memory` tool, and gives the model `upstash_memory_save` / `_search` / `_forget` and `upstash_chat_search`. It reads and writes the same keys and Redis Search indexes as `AgentMemory` and `ChatHistory` in `@upstash/agentkit-sdk`, so memories are shared with AgentKit apps on the same database.
