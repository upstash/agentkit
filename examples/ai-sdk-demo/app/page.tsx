import Console from "./components/Console";

export default function Page() {
  return (
    <>
      <h1>@upstash/agentkit-ai-sdk</h1>
      <p className="muted">
        A <code>generateText</code> agent with memory tools (<code>recall_memory</code> /{" "}
        <code>save_memory</code>), schema-driven Redis Search tools (<code>search</code> /{" "}
        <code>aggregate</code> / <code>count</code>), a cached tool (<code>convert_price</code>), all
        on a <code>rateLimitedModel</code>. Backed by a real Upstash Redis; set{" "}
        <code>OPENAI_API_KEY</code> + Upstash creds in the repo-root <code>.env</code>.
      </p>
      <Console
        presets={[
          "Remember that I love science fiction.",
          "What do you know about me?",
          "How many books in the index are by Ursula K. Le Guin?",
        ]}
      />
    </>
  );
}
