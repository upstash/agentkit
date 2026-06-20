import { USER, getHistory, seedBooks } from "../../lib/chat";
import Chat from "../../components/Chat";
import Sidebar from "../../components/Sidebar";

export const dynamic = "force-dynamic";

export default async function ChatPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;

  // Seed the books index once (flag-gated in Redis) so the search tools have data to return.
  await seedBooks();

  // Server-load the stored transcript so `useChat` is seeded with the full history on first render.
  const history = getHistory();
  const chat = await history.getChat(USER, id);

  return (
    <div className="layout">
      <Sidebar activeId={id} />
      <section className="chat-pane">
        <Chat id={id} initialMessages={chat?.messages ?? []} title={chat?.title} />
      </section>
    </div>
  );
}
