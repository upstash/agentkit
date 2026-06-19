import { NextResponse } from "next/server";
import { AgentMemory, ChatHistory, SemanticCache, Telemetry, ToolCache } from "@upstash/agentkit-sdk";
import { generate, getRedis, modelCalls, singleton } from "../../lib/agentkit";

export const runtime = "nodejs";

const mem = () =>
  singleton("sdk:mem", () => new AgentMemory({ redis: getRedis(), namespace: "demo:sdk:mem" }));
const hist = () =>
  singleton(
    "sdk:chat",
    () => new ChatHistory({ redis: getRedis(), namespace: "demo:sdk:chat", maxMessages: 50 }),
  );
const semcache = () =>
  singleton(
    "sdk:cache",
    () => new SemanticCache({ redis: getRedis(), namespace: "demo:sdk:cache", minScore: 0.5 }),
  );
const tel = () =>
  singleton("sdk:tel", () => new Telemetry({ redis: getRedis(), namespace: "demo:sdk:telemetry" }));
const tools = () =>
  singleton("sdk:tool", () => new ToolCache({ redis: getRedis(), namespace: "demo:sdk:tool" }));

const ARITHMETIC = /^[\d\s+\-*/%().]+$/;
const isArithmetic = (s: string) =>
  ARITHMETIC.test(s.trim()) && /[+\-*/%]/.test(s) && /\d/.test(s);

function safeEval(expr: string): number {
  if (!ARITHMETIC.test(expr)) throw new Error("unsupported expression");
  // eslint-disable-next-line no-new-func
  const out = new Function(`"use strict"; return (${expr});`)();
  if (typeof out !== "number" || !Number.isFinite(out)) throw new Error("not a finite number");
  return out;
}

export async function POST(req: Request) {
  try {
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };

    if (/^remember\b/i.test(input.trim())) {
      const fact = input.trim().replace(/^remember\s+(that\s+)?/i, "");
      const rec = await mem().add(fact, { scope: sessionId });
      await mem().searchIndex.waitIndexing();
      return NextResponse.json({
        ok: true,
        summary: `Stored a memory for "${sessionId}".`,
        steps: [{ label: "AgentMemory.add", detail: fact }],
        data: { id: rec.id },
      });
    }

    const steps: { label: string; detail: string }[] = [];

    const result = await tel().trace(
      "sdk.turn",
      async () => {
        const recalled = await mem().recall(input, { scope: sessionId, topK: 3 });
        steps.push({
          label: "AgentMemory.recall",
          detail: recalled.length
            ? recalled.map((m) => `${m.text} (${m.score.toFixed(1)})`).join("\n")
            : "no relevant memories",
        });

        const prior = await hist().list(sessionId, { limit: 6 });
        steps.push({ label: "ChatHistory.list", detail: `${prior.length} prior message(s)` });

        let response: string;
        let cacheHit = false;

        if (isArithmetic(input)) {
          // Deterministic tool result, memoized in the ToolCache.
          const value = await tools().wrap("calculator", async (e: string) => safeEval(e))(input);
          response = `The result is ${value}.`;
          steps.push({ label: "ToolCache.wrap(calculator)", detail: `${input} = ${value}` });
        } else {
          const before = modelCalls();
          const hit = await semcache().get(input);
          if (hit) {
            response = hit.response;
            cacheHit = true;
          } else {
            const memContext = recalled.length
              ? `Known facts:\n${recalled.map((m) => `- ${m.text}`).join("\n")}\n`
              : "";
            response = await generate(`${memContext}user: ${input}`);
            await semcache().set(input, response);
            // Demo: block until indexed so an immediate repeat shows a cache hit.
            await semcache().searchIndex.waitIndexing();
          }
          void before;
          steps.push({
            label: "SemanticCache (keyed on question)",
            detail: cacheHit ? "cache HIT — model not called" : "cache miss — model generated",
          });
        }

        await hist().append(sessionId, [
          { role: "user", content: input },
          { role: "assistant", content: response },
        ]);
        return { response, cacheHit };
      },
      { type: "run", attributes: { input } },
    );

    return NextResponse.json({ ok: true, summary: result.response, steps, data: { cacheHit: result.cacheHit } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
