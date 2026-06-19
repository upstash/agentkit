import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";

export default function Page() {
  // Start every visit on a fresh chat id; `/chat/<id>` loads (empty) and persists as you talk.
  redirect(`/chat/${randomUUID()}`);
}
