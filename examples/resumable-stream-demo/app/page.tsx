import { generateId } from "ai";
import { redirect } from "next/navigation";
import { connection } from "next/server";

/** Starts a new chat. The URL is the chat: reload it, or open it in another tab. */
export default async function Home() {
  await connection(); // render per request, so every visit gets a new id
  redirect(`/chat/${generateId()}`);
}
