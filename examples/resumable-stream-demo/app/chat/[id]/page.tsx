import { readChat } from "@/lib/chat-store";
import { Chat } from "./chat";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { messages } = await readChat(id);
  return <Chat id={id} initialMessages={messages} />;
}
