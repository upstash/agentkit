/**
 * A stand-in for the host's callback (ChatGPT's, in production), so the demo can show a delivery
 * end to end without a public URL.
 *
 * - `PUT  ?id=…` with `{ secret }` registers a receiver and its signing secret.
 * - `POST ?id=…` is the callback: it checks the Standard Webhooks signature, answers the
 *   verification challenge, and records every event.
 * - `GET  ?id=…` returns what it received.
 * - `DELETE ?id=…` forgets the receiver, so its next POST answers 410, which tells the server to
 *   delete the subscription (the way a host drops one).
 *
 * State is in process memory: fine for `next dev`, not for anything real.
 */
import { verifyWebhook } from "@upstash/mcp-toolkit/events";

export const dynamic = "force-dynamic";

type Receiver = { secret: string; received: { valid: boolean; body: unknown }[] };
const receivers: Map<string, Receiver> = ((globalThis as { __receivers?: Map<string, Receiver> })
  .__receivers ??= new Map());

const idOf = (request: Request) => new URL(request.url).searchParams.get("id") ?? "";

export async function PUT(request: Request): Promise<Response> {
  const { secret } = (await request.json()) as { secret: string };
  receivers.set(idOf(request), { secret, received: [] });
  return new Response(null, { status: 204 });
}

export async function POST(request: Request): Promise<Response> {
  const receiver = receivers.get(idOf(request));
  if (!receiver) return new Response("unknown receiver", { status: 410 });
  const raw = await request.text();
  const valid = await verifyWebhook(receiver.secret, request.headers, raw);
  const body = JSON.parse(raw) as { type?: string; challenge?: string };
  receiver.received.push({ valid, body });
  if (!valid) return new Response("bad signature", { status: 401 });
  if (body.type === "verification") return Response.json({ challenge: body.challenge });
  return new Response(null, { status: 204 });
}

export async function DELETE(request: Request): Promise<Response> {
  receivers.delete(idOf(request));
  return new Response(null, { status: 204 });
}

export async function GET(request: Request): Promise<Response> {
  return Response.json(receivers.get(idOf(request))?.received ?? []);
}
