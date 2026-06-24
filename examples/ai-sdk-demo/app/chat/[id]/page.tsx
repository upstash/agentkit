import { cookies } from "next/headers";
import { getHistory, seedBooks } from "../../lib/chat";
import { USER_COOKIE, normalizeUser } from "../../lib/users";
import Chat from "../../components/Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  // Seed the books index once (flag-gated in Redis) so the search tools have data to return.
  await seedBooks();

  // The active user comes from the cookie (set by the user switcher) so SSR scopes to the right user.
  const userId = normalizeUser((await cookies()).get(USER_COOKIE)?.value);

  // Server-load this user's stored transcript so `useChat` is seeded with the full history.
  const chat = await getHistory().getChat({ userId, sessionId: id });

  // The sidebar lives in app/chat/layout.tsx (persists across chats); the page only renders the chat.
  return <Chat id={id} initialMessages={chat?.messages ?? []} title={chat?.title} />;
}
