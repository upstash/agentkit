import { s } from "@upstash/redis";

/**
 * The one Redis Search index `AgentMemory` and `ChatHistory` share by default, so both work on a
 * database that allows a single index (Upstash's Free plan). The same definition as the Python
 * package (`upstash-hermes-memory`), so both languages read and write the same index.
 *
 * Chats carry `kind: "chat"`; memories carry no `kind`. Only the memory `text` is HYBRID (full-text
 * plus an embedding for `$ann`): a chat transcript is one long value, so it stays TEXT.
 */
export const SHARED_INDEX_NAME = "agentkit";
export const SHARED_MEMORY_PREFIX = "agentkit:memory";
export const SHARED_CHAT_PREFIX = "agentkit:chat";
export const SHARED_PREFIXES = [`${SHARED_MEMORY_PREFIX}:`, `${SHARED_CHAT_PREFIX}:`];

export const SharedSchema = s.object({
  kind: s.string().noTokenize(),
  userId: s.string().noTokenize(),
  text: s.hybrid(),
  sessionId: s.string().noTokenize(),
  userMessages: s.string(),
  modelMessages: s.string(),
});

/**
 * Matches chat rows in the shared index. Chats are told apart by `sessionId`, which every chat has and
 * no memory does, rather than by `kind`: chats saved before the shared index have no `kind`. Search has
 * no "field exists" operator; `$regex` on the untokenized `sessionId` serves as one.
 */
export const IS_CHAT = { sessionId: { $regex: ".+" } };
