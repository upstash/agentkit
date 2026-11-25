/**
 * The chat model: OpenAI when `OPENAI_API_KEY` is set, otherwise (or with `AGENTKIT_MOCK_MODEL=1`) a
 * scripted model that streams a long answer one word at a time (`MOCK_WORD_DELAY_MS`, default 100),
 * so there is time to reload or stop it mid-answer.
 */
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;

const FILLER =
  "This answer comes from a scripted model, one word at a time. Reload the page and it carries on " +
  "from Upstash Redis, open the chat in a second tab and both follow along, or press Stop in either " +
  "tab and the generation ends everywhere, whichever server instance is running it.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mockModel(): LanguageModel {
  const delay = Number(process.env.MOCK_WORD_DELAY_MS ?? 100);
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const lastUser = prompt.findLast((m) => m.role === "user");
      const said = (lastUser?.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const words = [`You said: ${said}.`, FILLER, FILLER, FILLER].join(" ").split(" ");
      let i = 0;
      // Pulled one word at a time, so a stopped `streamText` (which cancels it) ends it at once.
      const stream = new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
        },
        async pull(controller) {
          if (i < words.length) {
            await sleep(delay);
            controller.enqueue({ type: "text-delta", id: "text", delta: (i ? " " : "") + words[i++] });
            return;
          }
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: words.length, text: words.length, reasoning: 0 },
            },
          });
          controller.close();
        },
      });
      return { stream };
    },
  });
}

export function chatModel(): LanguageModel {
  if (process.env.AGENTKIT_MOCK_MODEL === "1" || !process.env.OPENAI_API_KEY) return mockModel();
  return openai(process.env.OPENAI_MODEL ?? "gpt-5.4-mini");
}
