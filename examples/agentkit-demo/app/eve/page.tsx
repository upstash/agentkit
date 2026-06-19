import DemoConsole from "../components/DemoConsole";
import DemoHeader from "../components/DemoHeader";

export default function EvePage() {
  return (
    <div>
      <DemoHeader title="Vercel Eve" pkg="@upstash/agentkit-eve">
        <code>withAgentKit()</code> augments an Eve agent in one call: tools become sandboxed +
        cached, instructions are enriched with recalled memories, the conversation persists via
        history hooks, and the run is wrapped in a telemetry trace with a semantic cache. Try a
        <code>remember …</code> line first, then ask something related.
      </DemoHeader>
      <DemoConsole
        endpoint="/api/eve"
        placeholder="Ask something, or 'remember that …'"
        hint="Remember a fact, then ask about it"
        presets={[
          "remember that the user works in fintech",
          "what industry is the user in?",
          "Give me a fun fact",
          "Give me a fun fact",
        ]}
      />
    </div>
  );
}
