"use client";

import { useState } from "react";
import { useEveAgent } from "eve/react";

const PRESETS = [
  "Remember that I love science fiction.",
  "What do you know about me?",
  "How many books in the index are by Ursula K. Le Guin?",
  "What's the weather in Paris?",
];

export function AgentChat() {
  const [input, setInput] = useState("");
  const agent = useEveAgent();
  const busy = agent.status === "submitted" || agent.status === "streaming";

  function send(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    void agent.send({ message: value });
    setInput("");
  }

  return (
    <main className="app">
      <div className="chat">
        <h1>@upstash/agentkit-eve</h1>

        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p} className="preset" onClick={() => send(p)} disabled={busy}>
              {p}
            </button>
          ))}
        </div>

        {agent.error ? (
          <div className="card tool-err">
            <div className="muted">Error</div>
            <div>{agent.error.message}</div>
          </div>
        ) : null}

        <div className="messages">
          {agent.data.messages.length === 0 && (
            <p className="muted">
              An eve agent backed by <code>@upstash/agentkit-eve</code>. It has memory tools
              (<code>recall_memory</code> / <code>save_memory</code>), schema-driven Redis Search tools
              over a books index (<code>search_books</code> / <code>aggregate_books</code> /{" "}
              <code>count_books</code>), and a cached <code>get_weather</code> tool; requests are
              rate-limited at the channel.
            </p>
          )}
          {agent.data.messages.map((m) => {
            const text = m.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
            return (
              <div className="card" key={m.id}>
                <div className="muted">{m.role === "user" ? "You" : "Assistant"}</div>
                {/* Show every tool the agent called, with its state + result. */}
                {m.parts.map((part, i) =>
                  part.type === "dynamic-tool" ? (
                    <div className="tool-call" key={i}>
                      <span className="tool-tag">🔧 {part.toolName}</span>
                      <span className="muted"> · {part.state}</span>
                      {part.output != null ? (
                        <pre className="tool-io">{JSON.stringify(part.output, null, 2)}</pre>
                      ) : null}
                      {part.errorText ? (
                        <pre className="tool-io tool-err">{part.errorText}</pre>
                      ) : null}
                    </div>
                  ) : null,
                )}
                {text ? <div>{text}</div> : <span className="muted">…</span>}
              </div>
            );
          })}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            {busy ? "…" : "Send"}
          </button>
        </form>
      </div>
    </main>
  );
}
