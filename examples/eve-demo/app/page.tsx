import Console from "./components/Console";

export default function Page() {
  return (
    <>
      <h1>@upstash/agentkit-eve</h1>
      <p className="muted">
        The Eve adapter&apos;s building blocks, exercised directly: memory tools
        (<code>defineMemorySaveTool</code> / <code>defineMemoryRecallTool</code>), a cached tool
        (<code>defineCachedTool</code>), and a semantic-cached model
        (<code>@upstash/agentkit-eve/model</code>). The Upstash Box sandbox backend
        (<code>upstash()</code> from <code>/sandbox</code>) plugs into Eve&apos;s <code>defineSandbox</code>
        and runs inside the framework. Needs Upstash + OpenAI creds in the repo-root <code>.env</code>.
      </p>
      <Console presets={["remember that I deploy on Vercel", "where do I deploy?"]} />
    </>
  );
}
