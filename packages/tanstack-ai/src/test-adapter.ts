/**
 * Test-only: a scripted TanStack AI text adapter, so middleware and memory are exercised through a
 * real `chat()` agent loop without a model provider. `turns[i]` is what the model "says" on call i:
 * either a list of tool calls or a final text answer. The last entry repeats if the loop runs longer.
 */
import type { StreamChunk } from "@tanstack/ai";

export type ScriptedTurn =
  | { toolCalls: Array<{ id: string; name: string; args: unknown }> }
  | { text: string };

export interface ScriptedAdapter {
  kind: "text";
  name: string;
  model: string;
  "~types": never;
  /** Every `chatStream` call's options, for asserting on what the loop sent the model. */
  calls: Array<{ messages: unknown[]; systemPrompts?: unknown; tools?: unknown[] }>;
  chatStream: (options: unknown) => AsyncIterable<StreamChunk>;
  structuredOutput: () => Promise<never>;
}

export function scriptedAdapter(turns: ScriptedTurn[]): ScriptedAdapter {
  const calls: ScriptedAdapter["calls"] = [];
  return {
    kind: "text",
    name: "scripted",
    model: "scripted-1",
    "~types": undefined as never,
    calls,
    async *chatStream(options: unknown) {
      calls.push(options as ScriptedAdapter["calls"][number]);
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)]!;
      const timestamp = Date.now();
      const n = calls.length;
      if ("toolCalls" in turn) {
        for (const call of turn.toolCalls) {
          yield {
            type: "TOOL_CALL_START",
            toolCallId: call.id,
            toolCallName: call.name,
            toolName: call.name,
            timestamp,
          } as unknown as StreamChunk;
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId: call.id,
            delta: JSON.stringify(call.args),
            timestamp,
          } as unknown as StreamChunk;
          yield {
            type: "TOOL_CALL_END",
            toolCallId: call.id,
            toolCallName: call.name,
            toolName: call.name,
            input: call.args,
            timestamp,
          } as unknown as StreamChunk;
        }
        yield {
          type: "RUN_FINISHED",
          finishReason: "tool_calls",
          timestamp,
        } as unknown as StreamChunk;
      } else {
        const messageId = `msg-${n}`;
        yield {
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
          timestamp,
        } as unknown as StreamChunk;
        yield {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: turn.text,
          timestamp,
        } as unknown as StreamChunk;
        yield { type: "TEXT_MESSAGE_END", messageId, timestamp } as unknown as StreamChunk;
        yield { type: "RUN_FINISHED", finishReason: "stop", timestamp } as unknown as StreamChunk;
      }
    },
    structuredOutput: async () => {
      throw new Error("scriptedAdapter: structuredOutput is not scripted");
    },
  };
}
