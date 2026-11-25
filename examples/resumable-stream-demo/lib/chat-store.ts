/**
 * Chat storage: one Redis hash per chat with the transcript (`messages`) and, while an answer is
 * being generated, the id of its resumable stream (`activeStreamId`), as in the AI SDK guide.
 *
 * The client is created on first use, not at import, so `next build` needs no credentials.
 */
import { Redis } from "@upstash/redis";
import type { UIMessage } from "ai";

const key = (id: string) => `resumable-stream-demo:chat:${id}`;
const TTL_SECONDS = 7 * 24 * 3600;

let client: Redis | undefined;
const redis = () => (client ??= Redis.fromEnv());

export async function readChat(
  id: string,
): Promise<{ messages: UIMessage[]; activeStreamId: string | null }> {
  const chat = await redis().hgetall<{ messages?: UIMessage[]; activeStreamId?: string }>(key(id));
  return { messages: chat?.messages ?? [], activeStreamId: chat?.activeStreamId ?? null };
}

/** Saves the transcript and clears `activeStreamId`. */
export async function saveMessages(id: string, messages: UIMessage[]): Promise<void> {
  await redis()
    .pipeline()
    .hset(key(id), { messages })
    .hdel(key(id), "activeStreamId")
    .expire(key(id), TTL_SECONDS)
    .exec();
}

export async function setActiveStreamId(id: string, streamId: string): Promise<void> {
  await redis().hset(key(id), { activeStreamId: streamId });
}
