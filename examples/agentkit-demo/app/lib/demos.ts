/** Registry of the agentkit demos — used by the home page and the nav. */
export interface Demo {
  slug: string;
  title: string;
  pkg: string;
  blurb: string;
}

export const demos: Demo[] = [
  {
    slug: "sdk",
    title: "Core SDK",
    pkg: "@upstash/agentkit-sdk",
    blurb:
      "One agent turn wiring together memory recall, chat history, a cached tool, semantic caching, and a telemetry trace.",
  },
  {
    slug: "ai-sdk",
    title: "Vercel AI SDK",
    pkg: "@upstash/agentkit-ai-sdk",
    blurb:
      "History store + memory injection as CoreMessages, semantic-cached generation, and a cached AI SDK tool.",
  },
  {
    slug: "tanstack-ai",
    title: "TanStack AI",
    pkg: "@upstash/agentkit-tanstack-ai",
    blurb:
      "A server chat handler that persists both sides of the turn, plus a cached tool and semantic-cached model.",
  },
  {
    slug: "langchain",
    title: "LangChain.js",
    pkg: "@upstash/agentkit-langchain",
    blurb:
      "RedisChatMessageHistory, an AgentKitRetriever (RAG), a semantic LLM cache, and a cached tool.",
  },
  {
    slug: "eve",
    title: "Vercel Eve",
    pkg: "@upstash/agentkit-eve",
    blurb:
      "withAgentKit() composes cached+traced tools, memory/RAG-augmented instructions, history, and traced runs.",
  },
];
