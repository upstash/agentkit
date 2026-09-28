/**
 * The chat model. With `OPENAI_API_KEY` set it is OpenAI; with `AGENTKIT_MOCK_MODEL=1` (CI, the E2E
 * suite) it is a scripted stand-in, so the whole app runs deterministically with no provider:
 *
 * - A message starting with `remember:` makes the model call the `save_memory` tool with the rest.
 * - Otherwise it answers `You said: <message>.`, then `I remember: …` with any memories that were
 *   recalled into the system prompt, then a short filler (three times over for `long:` messages) — streamed one word at a time
 *   (`MOCK_WORD_DELAY_MS`, default 40) so a client can disconnect mid-answer.
 */
import { openaiText } from "@tanstack/ai-openai";
import type { StreamChunk } from "@tanstack/ai";

type Adapter = ReturnType<typeof openaiText>;

const FILLER =
  "This answer is streamed word by word so a reload in the middle of it can be resumed from the " +
  "durable log on any server instance until the very last word arrives.";

interface CallOptions {
  messages: Array<{ role: string; content: unknown }>;
  systemPrompts?: unknown;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p === "object" && "content" in p ? String(p.content) : "")).join("")
      : "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockModel(): Adapter {
  const delay = Number(process.env.MOCK_WORD_DELAY_MS ?? 40);
  let calls = 0;
  const adapter = {
    kind: "text",
    name: "mock",
    model: "mock-1",
    async *chatStream(options: CallOptions): AsyncIterable<StreamChunk> {
      calls++;
      const timestamp = Date.now();
      const last = options.messages.at(-1);
      const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
      const said = textOf(lastUser?.content).trim();

      // First step of a "remember:" turn: call save_memory. The tool result comes back as a `tool`
      // message, and the next step (below) answers in text.
      if (said.toLowerCase().startsWith("remember:") && last?.role !== "tool") {
        const id = `call-${calls}-${timestamp}`;
        const args = { text: said.slice("remember:".length).trim() };
        yield { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "save_memory", toolName: "save_memory", timestamp } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args), timestamp } as unknown as StreamChunk;
        yield { type: "TOOL_CALL_END", toolCallId: id, toolCallName: "save_memory", toolName: "save_memory", input: args, timestamp } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED", finishReason: "tool_calls", timestamp } as unknown as StreamChunk;
        return;
      }

      // Memories recalled into the system prompt, one "- <text> (<source>)" line each.
      const prompts = Array.isArray(options.systemPrompts) ? options.systemPrompts : [];
      const recalled = prompts
        .map((p) => (typeof p === "string" ? p : textOf((p as { content?: unknown })?.content)))
        .join("\n")
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).replace(/ \((you saved this|the user said this)\)$/, ""))
        .sort();
      const answer =
        last?.role === "tool"
          ? "Saved."
          : [
              `You said: ${said}.`,
              recalled.length ? `I remember: ${recalled.join("; ")}.` : "",
              // "long:" triples the filler, for a run that must outlast a short producer lease.
              ...(said.toLowerCase().startsWith("long:") ? [FILLER, FILLER, FILLER] : [FILLER]),
            ]
              .filter(Boolean)
              .join(" ");

      const messageId = `msg-${calls}-${timestamp}`;
      yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp } as unknown as StreamChunk;
      const words = answer.split(" ");
      for (const [i, word] of words.entries()) {
        if (delay > 0) await sleep(delay);
        yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: i === 0 ? word : ` ${word}`, timestamp: Date.now() } as unknown as StreamChunk;
      }
      yield { type: "TEXT_MESSAGE_END", messageId, timestamp: Date.now() } as unknown as StreamChunk;
      yield { type: "RUN_FINISHED", finishReason: "stop", timestamp: Date.now() } as unknown as StreamChunk;
    },
    structuredOutput: async () => {
      throw new Error("The mock model does not do structured output.");
    },
  };
  // The mock implements the same streaming surface chat() drives; it is typed as the real adapter
  // so the route code is identical in both modes.
  return adapter as unknown as Adapter;
}

export function chatModel(): Adapter {
  if (process.env.AGENTKIT_MOCK_MODEL === "1") return mockModel();
  return openaiText((process.env.OPENAI_MODEL ?? "gpt-5.4-mini") as Parameters<typeof openaiText>[0]);
}
