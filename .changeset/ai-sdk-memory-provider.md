---
"@upstash/agentkit-ai-sdk": minor
---

Add `createAgentMemory`, an AI SDK memory provider backed by Upstash Redis Search. Create it once, then per request use `memory.tools({ userId })` (the `recall_memory` / `save_memory` tools), `memory.prepareStep({ userId })` to inject the memories relevant to the latest user message into the instructions automatically (works with `generateText`, `streamText` and `ToolLoopAgent`, with `userId` optionally derived from `runtimeContext`), `memory.recallContext()` to build instructions yourself, and `memory.instructions` for tool-usage guidance. The model is never wrapped, and a failed recall never fails the call.
