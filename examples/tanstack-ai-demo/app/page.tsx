"use client";

/**
 * A chat whose state lives on the server, in Upstash. The page keeps nothing of its own: on mount
 * `useChat` asks the route for the thread (transcript + any run still in flight) and tails that run.
 * Reload mid-answer, or open the same URL on another device, and it picks up where the stream is.
 */
import { useEffect, useState } from "react";
import { fetchServerSentEvents } from "@tanstack/ai-client";
import { useChat } from "@tanstack/ai-react";

const connection = fetchServerSentEvents("/api/chat");

/** The thread lives in the URL (`?thread=`), so a reload or a shared link lands on the same one. */
function useThreadId(): string | null {
  const [threadId, setThreadId] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    let id = url.searchParams.get("thread");
    if (!id) {
      id = `thread-${crypto.randomUUID()}`;
      url.searchParams.set("thread", id);
      window.history.replaceState(null, "", url);
    }
    setThreadId(id);
  }, []);
  return threadId;
}

function Chat({ threadId }: { threadId: string }) {
  const { messages, sendMessage, isLoading, connectionStatus } = useChat({
    threadId,
    connection,
    persistence: true,
  });
  const [input, setInput] = useState("");

  return (
    <main>
      <header>
        <h1>TanStack AI on Upstash</h1>
        <span className={`status ${connectionStatus}`}>{connectionStatus}</span>
      </header>
      <p className="hint">
        Transcripts, runs and the stream live in Upstash Redis. Reload mid-answer, or open this URL
        in another tab: the answer continues. Try <code>remember: I like green tea</code>, then ask
        something in a <a href="/">new thread</a>.
      </p>
      <ol className="thread">
        {messages.map((message) => (
          <li key={message.id} className={message.role}>
            {message.parts.map((part, i) =>
              part.type === "text" ? (
                <p key={i}>{part.content}</p>
              ) : part.type === "tool-call" ? (
                <p key={i} className="tool">
                  ⚙ {part.name}
                </p>
              ) : null,
            )}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = input.trim();
          if (!text || isLoading) return;
          setInput("");
          void sendMessage(text);
        }}
      >
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Say something"
          aria-label="Message"
        />
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Streaming…" : "Send"}
        </button>
      </form>
    </main>
  );
}

export default function Page() {
  const threadId = useThreadId();
  return threadId ? <Chat key={threadId} threadId={threadId} /> : null;
}
