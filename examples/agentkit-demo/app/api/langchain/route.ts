import { NextResponse } from "next/server";
import { ToolCache } from "@upstash/agentkit-sdk";
import {
  AgentKitRetriever,
  cacheTool,
  RedisChatMessageHistory,
  SemanticLLMCache,
} from "@upstash/agentkit-langchain";
import { generate, redis, searchStore } from "../../lib/agentkit";

export const runtime = "nodejs";

const retriever = new AgentKitRetriever({
  search: searchStore("lc:rag"),
  chunkSize: 200,
  chunkOverlap: 40,
  topK: 3,
});

const llmCache = new SemanticLLMCache({ search: searchStore("lc:llmcache"), minScore: 0.5 });
const toolCache = new ToolCache({ redis, namespace: "demo:lc:tool" });

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
        "Upstash Redis Search adds full-text and fuzzy search to Redis. Its $smart operator powers semantic-style retrieval and RAG without a separate vector database.",
      metadata: { source: "search-docs" },
    },
    {
      pageContent:
        "Redis AgentKit adds agent primitives on top of Upstash Redis: long-term memory, chat history, semantic caching, tool-call caching, telemetry, a tool sandbox, and RAG.",
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

    const history = new RedisChatMessageHistory({ redis, namespace: "demo:lc:chat", sessionId });
    await history.addUserMessage(input);

    // RAG retrieval via the LangChain-style retriever.
    const docs = await retriever.invoke(input);
    steps.push({
      label: "AgentKitRetriever.invoke",
      detail: docs.length
        ? docs.map((d) => `• ${d.pageContent.slice(0, 70)}…`).join("\n")
        : "no documents retrieved",
    });

    // Semantic LLM cache: reuse a response for a fuzzily similar question.
    let response: string;
    let cacheHit = false;
    const hit = await llmCache.lookup(input);
    if (hit && hit.length > 0) {
      response = hit[0]!.text;
      cacheHit = true;
    } else {
      const context = docs.map((d) => d.pageContent).join("\n");
      response = await generate(`Context:\n${context}\n\nQuestion: ${input}`);
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
