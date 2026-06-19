import DemoConsole from "../components/DemoConsole";
import DemoHeader from "../components/DemoHeader";

export default function SdkPage() {
  return (
    <div>
      <DemoHeader title="Core SDK" pkg="@upstash/agentkit-sdk">
        A single agent turn wired by hand: it recalls long-term memories, loads chat history, routes
        arithmetic through the sandboxed <code>calculator</code> tool, answers via a semantic cache,
        and records a telemetry trace. Start with a <code>remember …</code> line, then ask something
        related. Ask the same question twice to see a cache hit.
      </DemoHeader>
      <DemoConsole
        endpoint="/api/sdk"
        placeholder="Ask a question, do math (e.g. 2 + 2 * 3), or 'remember that …'"
        hint="Send the same question twice → cache hit"
        presets={[
          "remember that the user loves hiking",
          "what does the user enjoy?",
          "12 * (3 + 4)",
          "What is the capital of France?",
          "What is the capital of France?",
        ]}
      />
    </div>
  );
}
