"use client";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { USER_HEADER } from "../lib/users";
import { useUser } from "./UserProvider";

const PRESETS = [
  "Remember that I love science fiction.",
  "What do you know about me?",
  "How many books in the index are by Ursula K. Le Guin?",
];

export default function Chat({
  id,
  initialMessages,
  title,
}: {
  id: string;
  initialMessages: UIMessage[];
  title?: string;
}) {
  const { userId } = useUser();
  const [input, setInput] = useState("");
  // Posts the WHOLE messages array + the chat id to /api/chat, with the user id as a header so the
  // server scopes memory / history / cache / rate limit to this user.
  const { messages, sendMessage, status } = useChat({
    id,
    messages: initialMessages,
    transport: new DefaultChatTransport({ headers: { [USER_HEADER]: userId } }),
  });
  const busy = status === "submitted" || status === "streaming";

  function send(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    sendMessage({ text: value });
    setInput("");
  }

  return (
    <div className="chat">
      <h1>{title ?? "New chat"}</h1>

      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p} className="preset" onClick={() => send(p)} disabled={busy}>
            {p}
          </button>
        ))}
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <p className="muted">
            A streaming chat backed by <code>@upstash/agentkit-ai-sdk</code>. Every turn is persisted to
            Upstash Redis with <code>createChatHistory</code> — reload or revisit from the sidebar to
            resume. The sidebar also fuzzy-searches your chats (<code>searchChats</code>). The agent has
            memory tools (<code>recall_memory</code> / <code>save_memory</code>), schema-driven Redis
            Search tools over a books index (<code>search</code> / <code>aggregate</code> /{" "}
            <code>count</code>), and a cached tool (<code>convert_price</code>); requests are rate-limited
            before the model call.
          </p>
        )}
        {messages.map((m) => {
          const text = m.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
          return (
            <div className="card" key={m.id}>
              <div className="muted">{m.role === "user" ? "You" : "Assistant"}</div>
              {/* Show every tool the model called, with its state + result. */}
              {m.parts.map((part, i) => {
                if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return null;
                const p = part as {
                  state?: string;
                  toolName?: string;
                  output?: unknown;
                  errorText?: string;
                };
                const name = part.type === "dynamic-tool" ? (p.toolName ?? "tool") : part.type.slice(5);
                return (
                  <div className="tool-call" key={i}>
                    <span className="tool-tag">🔧 {name}</span>
                    {p.state ? <span className="muted"> · {p.state}</span> : null}
                    {p.output != null ? (
                      <pre className="tool-io">{JSON.stringify(p.output, null, 2)}</pre>
                    ) : null}
                    {p.errorText ? <pre className="tool-io tool-err">{p.errorText}</pre> : null}
                  </div>
                );
              })}
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
  );
}
