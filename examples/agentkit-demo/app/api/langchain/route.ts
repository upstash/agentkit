import { NextResponse } from "next/server";
import {
  AgentKitRetriever,
  cacheTool,
  RedisChatMessageHistory,
  SemanticLLMCache,
} from "@upstash/agentkit-langchain";
import { embedder, generate, modelCalls, redis, toolCache, vector } from "../../lib/agentkit";

export const runtime = "nodejs";

const retriever = new AgentKitRetriever({
  vector,
  embedder,
  namespace: "demo:lc:rag",
  chunkSize: 200,
  chunkOverlap: 40,
  topK: 3,
});

const llmCache = new SemanticLLMCache({
  vector,
  embedder,
  namespace: "demo:lc:llmcache",
  minScore: 0.85,
});

// Seed the knowledge base exactly once per server process.
const globalForSeed = globalThis as unknown as { __lcSeeded?: boolean };
async function ensureSeeded() {
  if (globalForSeed.__lcSeeded) return;
  globalForSeed.__lcSeeded = true;
  await retriever.addDocuments([
    {
      pageContent:
        "Upstash Redis is a serverless database with per-request pricing, accessed over HTTP/REST so it works in edge and serverless runtimes.",
      metadata: { source: "redis-docs" },
    },
    {
      pageContent:
        "Upstash Vector is a serverless vector database. It powers semantic search and retrieval-augmented generation, and can embed text for you or accept your own vectors.",
      metadata: { source: "vector-docs" },
    },
    {
      pageContent:
        "Redis AgentKit adds agent primitives on top of Upstash: long-term memory, chat history, semantic caching, tool-call caching, telemetry, a tool sandbox, and RAG.",
      metadata: { source: "agentkit-docs" },
    },
  ]);
}

export async function POST(req: Request) {
  try {
    await ensureSeeded();
    const { input, sessionId = "default" } = (await req.json()) as {
      input: string;
      sessionId?: string;
    };
    const steps: { label: string; detail: string }[] = [];

    const history = new RedisChatMessageHistory({
      redis,
      namespace: "demo:lc:chat",
      sessionId,
    });
    await history.addUserMessage(input);

    // RAG retrieval via the LangChain-style retriever.
    const docs = await retriever.invoke(input);
    steps.push({
      label: "AgentKitRetriever.invoke",
      detail: docs.length
        ? docs.map((d) => `• ${d.pageContent.slice(0, 70)}…`).join("\n")
        : "no documents retrieved",
    });

    // Semantic LLM cache: reuse a response for a semantically similar question.
    let response: string;
    let cacheHit = false;
    const hit = await llmCache.lookup(input);
    if (hit && hit.length > 0) {
      response = hit[0]!.text;
      cacheHit = true;
    } else {
      const context = docs.map((d) => d.pageContent).join("\n");
      const before = modelCalls();
      response = await generate(`Context:\n${context}\n\nQuestion: ${input}`);
      void before;
      await llmCache.update(input, "demo-llm", [{ text: response }]);
    }
    steps.push({
      label: "SemanticLLMCache.lookup/update",
      detail: cacheHit ? "cache HIT — reused a cached generation" : "cache miss — generated + stored",
    });

    await history.addAIMessage(response);
    const messages = await history.getMessages();
    steps.push({
      label: "RedisChatMessageHistory.getMessages",
      detail: `${messages.length} message(s) for "${sessionId}"`,
    });

    // A cached LangChain-style tool.
    const charCount = cacheTool(
      { name: "charCount", func: ({ text }: { text: string }) => text.length },
      toolCache,
    );
    await charCount.invoke({ text: input });
    const len = await charCount.invoke({ text: input });
    steps.push({
      label: "cacheTool(charCount) ×2",
      detail: `length = ${len} (2nd call served from ToolCache)`,
    });

    return NextResponse.json({
      ok: true,
      summary: response,
      steps,
      data: { cacheHit, retrieved: docs, messages },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
