"use client";
import { useEffect, useState } from "react";

type ChatSummary = {
  sessionId: string;
  title?: string;
  messageCount: number;
  updatedAt: number;
  score?: number;
};

export default function Sidebar({ activeId }: { activeId: string }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [query, setQuery] = useState("");

  async function load(q?: string) {
    const url = q ? `/api/chats?q=${encodeURIComponent(q)}` : "/api/chats";
    const res = await fetch(url);
    const json = (await res.json()) as { chats: ChatSummary[] };
    setChats(json.chats ?? []);
  }

  // Load the list on mount and whenever the active chat changes (so new chats show up).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Debounced fuzzy search via searchChats(USER, q).
  useEffect(() => {
    const t = setTimeout(() => load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <aside className="sidebar">
      <a className="new-chat" href={`/`}>
        + New chat
      </a>

      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search chats…"
      />

      <nav className="chat-list">
        {chats.length === 0 && <p className="muted">No chats yet.</p>}
        {chats.map((c) => (
          <a
            key={c.sessionId}
            href={`/chat/${c.sessionId}`}
            className={"chat-link" + (c.sessionId === activeId ? " active" : "")}
          >
            <span className="chat-title">{c.title || "Untitled chat"}</span>
            <span className="muted chat-meta">
              {c.messageCount} msg{c.score !== undefined ? ` · ${c.score.toFixed(1)}` : ""}
            </span>
          </a>
        ))}
      </nav>
    </aside>
  );
}
