"use client";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";

// Send only the new message; the server has the rest of the chat.
const transport = new DefaultChatTransport({
  prepareSendMessagesRequest: ({ id, messages }) => ({
    body: { id, message: messages[messages.length - 1] },
  }),
});

export function Chat({ id, initialMessages }: { id: string; initialMessages: UIMessage[] }) {
  const [input, setInput] = useState("");
  // `resume: true` asks GET /api/chat/[id]/stream for an answer still being generated on mount.
  const { messages, sendMessage, status } = useChat({
    id,
    messages: initialMessages,
    resume: true,
    transport,
  });
  const busy = status === "submitted" || status === "streaming";

  return (
    <>
      {messages.map((m) => (
        <div className="card" key={m.id}>
          <div className="muted">{m.role === "user" ? "You" : "Assistant"}</div>
          {m.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </div>
      ))}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim() || busy) return;
          void sendMessage({ text: input.trim() });
          setInput("");
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask for a long answer, then reload mid-way"
          disabled={busy}
        />
        {busy ? (
          // Not `useChat`'s `stop()`: with resumable streams that only drops this tab's connection.
          <button
            type="button"
            onClick={() => void fetch(`/api/chat/${encodeURIComponent(id)}/stop`, { method: "POST" })}
          >
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </>
  );
}
