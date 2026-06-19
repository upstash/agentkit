import Console from "./components/Console";

export default function Page() {
  return (
    <>
      <h1>@upstash/agentkit-eve</h1>
      <p className="muted">
        The Eve adapter&apos;s building blocks, exercised directly: memory tools
        (<code>save_memory</code> / <code>recall_memory</code>), a <code>cachedExecute</code> tool, a
        semantic-cached model (<code>@upstash/agentkit-eve/model</code>), and a real Upstash Box
        sandbox (<code>upstash()</code> from <code>/sandbox</code>). Try <code>box: &lt;command&gt;</code>
        to run a shell command in a cloud sandbox. Needs Upstash + Box + OpenAI creds in the
        repo-root <code>.env</code>.
      </p>
      <Console
        presets={[
          "remember that I deploy on Vercel",
          "where do I deploy?",
          "box: node -e \"console.log('hello from box')\"",
        ]}
      />
    </>
  );
}
