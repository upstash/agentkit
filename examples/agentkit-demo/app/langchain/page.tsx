import DemoConsole from "../components/DemoConsole";
import DemoHeader from "../components/DemoHeader";

export default function LangChainPage() {
  return (
    <div>
      <DemoHeader title="LangChain.js" pkg="@upstash/agentkit-langchain">
        A pre-seeded <code>AgentKitRetriever</code> answers questions with RAG over an Upstash-Vector
        knowledge base, a <code>RedisChatMessageHistory</code> stores the conversation, and a
        <code>SemanticLLMCache</code> reuses responses for similar questions. A cached LangChain-style
        tool runs twice. Expand <em>raw data</em> for retrieved documents.
      </DemoHeader>
      <DemoConsole
        endpoint="/api/langchain"
        placeholder="Ask about Upstash Redis, Vector, or AgentKit…"
        hint="Ask a paraphrase → semantic LLM cache hit"
        presets={[
          "What is Upstash Vector?",
          "Tell me about Upstash's vector database",
          "What does Redis AgentKit provide?",
        ]}
      />
    </div>
  );
}
