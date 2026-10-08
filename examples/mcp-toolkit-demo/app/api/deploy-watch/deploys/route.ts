/**
 * Report a deploy, which fires `deploy.finished`. This stands in for your CI telling your server a
 * deploy finished. POST a partial deploy; anything left out gets a demo value:
 *
 *   curl -X POST $APP/api/deploy-watch/deploys -d '{"service":"checkout-api","status":"failed"}'
 *
 * Unauthenticated on purpose, so the demo is easy to drive. A real server must authenticate this
 * route (your CI's token, a signed webhook): anyone who can call it can fire events.
 */
import { randomBytes } from "node:crypto";
import { Deploy, reportDeploy } from "../../../lib/deploy-watch";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const input = (await request.json().catch(() => ({}))) as Partial<Deploy>;
  const deploy = Deploy.parse({
    id: randomBytes(4).toString("hex"),
    service: "checkout-api",
    environment: "production",
    status: "succeeded",
    commit: "Retry card payments once on gateway timeouts",
    author: "arda",
    durationSeconds: 94,
    url: "https://example.com/deploys",
    ...input,
  });
  const result = await reportDeploy(deploy);
  return Response.json({ deploy, ...result });
}
