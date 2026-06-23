import { USER, getHistory, seedBooks } from "../../lib/chat";
import Chat from "../../components/Chat";

export const dynamic = "force-dynamic";

export default async function ChatPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  // Seed the books index once (flag-gated in Redis) so the search tools have data to return.
  await seedBooks();

  // Server-load the stored transcript so `useChat` is seeded with the full history on first render.
  const chat = await getHistory().getChat({ userId: USER, sessionId: id });

  // The sidebar lives in app/chat/layout.tsx (persists across chats); the page only renders the chat.
  return <Chat id={id} initialMessages={chat?.messages ?? []} title={chat?.title} />;
}
