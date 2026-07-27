# @upstash/agentkit-eve-extension

## 0.4.0

### Minor Changes

- 399b20c: Add `search_chat_history` and `read_chat_history` tools, contributed whenever `chatHistory` is enabled

  Captured transcripts were write-only from the agent's side: the hook persisted every message to
  Upstash Redis, but nothing read them back, so recalling an earlier conversation wasn't possible
  without querying `ChatHistory` from your own code.

  `chatHistory: true` now also contributes two tools over the same store:

  - `<ns>__search_chat_history` — `{ query, target?, limit? }`, a typo-tolerant (`$smart`) search over
    what was said, returning matching chats as summaries (`sessionId`, `title`, `updatedAt`,
    `messageCount`, `score`). The current session is excluded — its text is already in context.
  - `<ns>__read_chat_history` — `{ sessionId, limit? }`, reads one of those chats back (newest messages
    last, capped at 50 per call with a `truncated` flag).

  Both pin `userId` from the session rather than model input, so a chat lookup can only reach the
  current user's own transcripts. They're dedicated tools rather than something you point the generic
  `search` tool at, which means your `search` slot stays free for RAG over your own data. Like the
  search tools they're dynamic, so they don't exist at all when `chatHistory` is off; drop them with
  `disableTool()` if you want capture without model-facing reads.

  The instructions fragment gains a short rule telling the model to look back at past conversations
  when the user refers to one.

## 0.3.1

### Patch Changes

- c198499: Rebuild on eve ≥0.25's dist packaging format (`eve.extension.source`/`.dist`, prebuilt `dist/extension` + compatibility manifest, dist-only tarball). Fixes installing the extension from npm: eve 0.25 rejects the old source-recompile format outright, and the prebuilt dist also removes the need to install `@upstash/agentkit-sdk` alongside the extension. Consumers need eve ≥0.25.2; apps that configure `search` also declare `@upstash/redis` themselves (their own mount file imports the `s` schema builder from it — a mount without `search` needs no extra installs).

## 0.3.0

### Minor Changes

- 463c788: Add `@upstash/agentkit-eve-extension`: AgentKit as a mountable eve extension (eve ≥0.24). One file in `agent/extensions/` composes memory tools, schema-aware Redis Search tools, an opt-in durable chat-history hook, and a memory instructions fragment under one namespace.

  `@upstash/agentkit-eve` moves to **eve 0.24.6** and **ai 7.0.30** (stable). Breaking: eve ≥0.24 replaced the sandbox backend handle's `dispose()` with `shutdown()` (fires only on server shutdown; the Upstash Box backend now pauses the box), and the `eve` peer range is now `>=0.24.0`.
