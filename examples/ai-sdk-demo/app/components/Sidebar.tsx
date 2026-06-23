"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { USER_HEADER } from "../lib/users";
import { useUser } from "./UserProvider";
import UserSwitcher from "./UserSwitcher";

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
  const { userId } = useUser();
  // Active chat id derived from the URL — no prop, so the sidebar never remounts on navigation.
  const activeId = pathname?.startsWith("/chat/") ? pathname.slice("/chat/".length) : "";

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [query, setQuery] = useState("");

  async function load(q?: string) {
    const url = q ? `/api/chats?q=${encodeURIComponent(q)}` : "/api/chats";
    // Identify the user via a header so the API lists only this user's chats.
    const res = await fetch(url, { headers: { [USER_HEADER]: userId } });
    const json = (await res.json()) as { chats: ChatSummary[] };
    setChats(json.chats ?? []);
  }

  // Reload after navigating (so a new chat shows up) or after switching users, keeping the query.
  useEffect(() => {
    load(query.trim() || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, userId]);

  // Debounced fuzzy search via searchChats({ userId, query }).
  useEffect(() => {
    const t = setTimeout(() => load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <aside className="sidebar">
      <UserSwitcher />

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
