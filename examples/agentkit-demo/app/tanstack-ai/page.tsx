import DemoConsole from "../components/DemoConsole";
import DemoHeader from "../components/DemoHeader";

export default function TanStackPage() {
  return (
    <div>
      <DemoHeader title="TanStack AI" pkg="@upstash/agentkit-tanstack-ai">
        A server-side <code>createChatHandler</code> loads prior history, calls the (semantic-cached)
        model, and persists both the user and assistant messages in one step. It also runs a
        <code>wrapTool</code>-memoized tool twice to show the second call hitting the ToolCache.
        Expand <em>raw data</em> for the full conversation.
      </DemoHeader>
      <DemoConsole
        endpoint="/api/tanstack-ai"
        placeholder="Say something to the assistant…"
        hint="Send the same message twice → cache hit"
        presets={["Hello there", "What is the capital of France?", "What is the capital of France?"]}
      />
    </div>
  );
}
