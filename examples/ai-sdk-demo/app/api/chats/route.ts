import { USER, getHistory } from "../../lib/chat";

export const runtime = "nodejs";

// GET /api/chats          → list the user's chats (summaries, newest first)
// GET /api/chats?q=<text>  → fuzzy-search the user's chats by what was said
export async function GET(req: Request) {
  const history = getHistory();
  const q = new URL(req.url).searchParams.get("q")?.trim();

  if (q) {
    const hits = await history.searchChats(USER, q, { target: "both", limit: 20 });
    return Response.json({ chats: hits });
  }

  const chats = await history.listChats(USER, { limit: 50 });
  return Response.json({ chats });
}
