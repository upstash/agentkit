import { NextResponse } from "next/server";
import {
  AgentMemory,
  ChatHistory,
  Sandbox,
  SemanticCache,
  Telemetry,
  ToolCache,
} from "@upstash/agentkit-sdk";
import { generate, modelCalls, redis, searchStore } from "../../lib/agentkit";

export const runtime = "nodejs";

const memory = new AgentMemory({ search: searchStore("sdk:mem"), redis, namespace: "demo:sdk:mem" });
const history = new ChatHistory({ redis, namespace: "demo:sdk:chat", maxMessages: 50 });
const cache = new SemanticCache({ search: searchStore("sdk:cache"), minScore: 0.8 });
const telemetry = new Telemetry({ redis, namespace: "demo:sdk:telemetry" });
const toolCache = new ToolCache({ redis, namespace: "demo:sdk:tool", ttlSeconds: 300 });

const ARITHMETIC = /^[\d\s+\-*/%().]+$/;

function isArithmetic(s: string): boolean {
  return ARITHMETIC.test(s.trim()) && /[+\-*/%]/.test(s) && /\d/.test(s);
}

function safeEval(expr: string): number {
  if (!ARITHMETIC.test(expr)) throw new Error("unsupported expression");
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expr});`);
  const out = fn();
  if (typeof out !== "number" || !Number.isFinite(out)) throw new Error("not a finite number");
  return out;
}

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };

    // "remember ..." stores a long-term memory instead of running a turn.
    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      const rec = await memory.add(fact, { scope: sessionId });
      return NextResponse.json({
        ok: true,
        summary: `Stored a memory for "${sessionId}".`,
        steps: [{ label: "AgentMemory.add", detail: fact }],
        data: { id: rec.id },
      });
    }

    const steps: { label: string; detail: string }[] = [];

    const result = await telemetry.trace(
      "sdk.turn",
      async (span) => {
        const traceId = span.data.traceId;

        const recalled = await memory.recall(input, { scope: sessionId, topK: 3 });
        steps.push({
          label: "AgentMemory.recall",
          detail: recalled.length
            ? recalled.map((m) => `${m.text} (${m.score.toFixed(2)})`).join("\n")
            : "no relevant memories",
        });

        const prior = await history.list(sessionId, { limit: 6 });
        steps.push({ label: "ChatHistory.list", detail: `${prior.length} prior message(s) loaded` });

        let toolAnswer: number | null = null;
        if (isArithmetic(input)) {
          const sandbox = new Sandbox({ timeoutMs: 3000, telemetry, toolCache });
          sandbox.register<{ expression: string }, number>({
            name: "calculator",
            description: "Evaluates a basic arithmetic expression",
            execute: async ({ expression }) => safeEval(expression),
          });
          const r = await sandbox.run<number>("calculator", { expression: input }, { traceId });
          if (r.ok) {
            toolAnswer = r.value ?? null;
            steps.push({
              label: "Sandbox.run(calculator)",
              detail: `= ${r.value}${r.cached ? " (cache hit)" : ""} · ${r.attempts} attempt(s)`,
            });
          } else {
            steps.push({ label: "Sandbox.run(calculator)", detail: `failed: ${r.error?.message}` });
          }
        }

        let response: string;
        let cacheHit = false;
        if (toolAnswer !== null) {
          response = `The result is ${toolAnswer}.`;
          steps.push({ label: "Response", detail: "answered directly from the tool result" });
        } else {
          // Build a context-rich prompt for the model, but key the cache on the user's question so
          // shared context (memory/history) doesn't cause false fuzzy matches across questions.
          const memContext = recalled.length
            ? `Known facts:\n${recalled.map((m) => `- ${m.text}`).join("\n")}\n`
            : "";
          const histContext = prior.map((m) => `${m.role}: ${m.content}`).join("\n");

          const before = modelCalls();
          const hit = await cache.get(input);
          if (hit) {
            response = hit.response;
            cacheHit = true;
          } else {
            response = await generate(`${memContext}${histContext}\nuser: ${input}`);
            await cache.set(input, response);
          }
          void before;
          steps.push({
            label: "SemanticCache (keyed on question)",
            detail: cacheHit
              ? "cache HIT — model was not called"
              : "cache miss — model generated a fresh response",
          });
        }

        await history.append(sessionId, [
          { role: "user", content: input },
          { role: "assistant", content: response },
        ]);

        return { response, traceId, cacheHit };
      },
      { type: "run", attributes: { input } },
    );

    const trace = await telemetry.getTrace(result.traceId);

    return NextResponse.json({
      ok: true,
      summary: result.response,
      steps,
      data: {
        cacheHit: result.cacheHit,
        trace: trace.map((s) => ({
          name: s.name,
          type: s.type,
          status: s.status,
          durationMs: s.durationMs,
          attributes: s.attributes,
        })),
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
