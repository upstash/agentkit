import { UserChat } from "@/app/_components/user-chat";
import { seedBooks } from "@/lib/books";

// Render per-request so the one-time (flag-gated) book seeding runs at request
// time, not during the build — the agent's first book search then returns data.
export const dynamic = "force-dynamic";

export default async function Page() {
  await seedBooks();
  return <UserChat />;
}
