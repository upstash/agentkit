import { getHistory } from "../../lib/chat";
import { USER_HEADER, normalizeUser } from "../../lib/users";

export const runtime = "nodejs";

// GET /api/chats          → list the user's chats (summaries, newest first)
// GET /api/chats?q=<text>  → fuzzy-search the user's chats by what was said
// ⚠️ DEMO ONLY: the user is identified by the client-supplied `x-user-id` header (allow-listed to two
// fixed demo users by `normalizeUser`). In production, derive `userId` from a VERIFIED server-side
// session (Clerk, Auth.js/NextAuth, Supabase Auth, Auth0, …), never from a client-supplied value.
export async function GET(req: Request) {
  const history = getHistory();
  const userId = normalizeUser(req.headers.get(USER_HEADER));
  const q = new URL(req.url).searchParams.get("q")?.trim();

  if (q) {
    const hits = await history.searchChats({ userId, query: q, target: "both", limit: 20 });
    return Response.json({ chats: hits });
  }

  const chats = await history.listChats({ userId, limit: 50 });
  return Response.json({ chats });
}
