---
"@upstash/agentkit-eve-extension": minor
---

Add `search_chat_history` and `read_chat_history` tools, contributed whenever `chatHistory` is enabled

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
