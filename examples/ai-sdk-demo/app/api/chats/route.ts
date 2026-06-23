import { getHistory } from "../../lib/chat";
import { USER_HEADER, normalizeUser } from "../../lib/users";

export const runtime = "nodejs";

// GET /api/chats          → list the user's chats (summaries, newest first)
// GET /api/chats?q=<text>  → fuzzy-search the user's chats by what was said
// The active user is identified by the `x-user-id` header, so each user sees only their own chats.
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
