import DemoConsole from "../components/DemoConsole";
import DemoHeader from "../components/DemoHeader";

export default function AiSdkPage() {
  return (
    <div>
      <DemoHeader title="Vercel AI SDK" pkg="@upstash/agentkit-ai-sdk">
        Loads history as AI SDK <code>CoreMessage</code>s, prepends recalled memories as a system
        message, runs a sandboxed AI-SDK tool (word counter), and serves generation through a
        semantic cache — persisting both sides of the turn. Expand <em>raw data</em> to see the
        CoreMessages.
      </DemoHeader>
      <DemoConsole
        endpoint="/api/ai-sdk"
        placeholder="Ask something, or 'remember that …'"
        hint="Send the same prompt twice → cache hit"
        presets={[
          "remember that the user is a TypeScript developer",
          "what language does the user prefer?",
          "Tell me about Upstash",
          "Tell me about Upstash",
        ]}
      />
    </div>
  );
}
