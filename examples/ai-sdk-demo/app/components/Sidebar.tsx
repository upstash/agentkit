"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

type ChatSummary = {
  sessionId: string;
  title?: string;
  messageCount: number;
  updatedAt: number;
  score?: number;
};

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  // Active chat id derived from the URL — no prop, so the sidebar never remounts on navigation.
  const activeId = pathname?.startsWith("/chat/") ? pathname.slice("/chat/".length) : "";

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [query, setQuery] = useState("");

  async function load(q?: string) {
    const url = q ? `/api/chats?q=${encodeURIComponent(q)}` : "/api/chats";
    const res = await fetch(url);
    const json = (await res.json()) as { chats: ChatSummary[] };
    setChats(json.chats ?? []);
  }

  // Refresh the list after navigating (so a newly-created chat shows up), keeping the current query.
  useEffect(() => {
    load(query.trim() || undefined);
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
      {/* Soft-navigate to a fresh chat id so the sidebar (and this search box) stays mounted. */}
      <button className="new-chat" onClick={() => router.push(`/chat/${crypto.randomUUID()}`)}>
        + New chat
      </button>

      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search chats…"
      />

      <nav className="chat-list">
        {chats.length === 0 && <p className="muted">No chats yet.</p>}
        {chats.map((c) => (
          <Link
            key={c.sessionId}
            href={`/chat/${c.sessionId}`}
            className={"chat-link" + (c.sessionId === activeId ? " active" : "")}
          >
            <span className="chat-title">{c.title || "Untitled chat"}</span>
            <span className="muted chat-meta">
              {c.messageCount} msg{c.score !== undefined ? ` · ${c.score.toFixed(1)}` : ""}
            </span>
          </Link>
        ))}
      </nav>
    </aside>
  );
}
