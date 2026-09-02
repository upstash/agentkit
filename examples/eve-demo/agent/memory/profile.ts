import { redisDocuments } from "@upstash/agentkit-eve/memory";
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

// eve's own `fileMemory()` provider — a small, model-curated list of durable facts recalled in
// full before every turn — but stored in Upstash Redis instead of Vercel Blob. Without a
// `backend`, `fileMemory()` only works under `eve dev` (process-local) or on Vercel with a Blob
// store attached; `redisDocuments()` makes it work anywhere, on the Redis you already have.
//
// The slot name (the filename) prefixes the tools eve generates from the provider, so the model
// sees `profile__save_memory` and `profile__remove_memory`.
export default defineMemory({
  description: "Stable facts and preferences about the caller, curated by the model.",
  // `redis` is omitted, so the backend defaults to Redis.fromEnv() on its own — agent files must
  // be self-contained, so there is no shared client module to import here.
  provider: fileMemory({ backend: redisDocuments() }),
  // Scope memory to the selected user (the auth principal set from the `x-user-id` header in
  // agent/channels/eve.ts), falling back to the session when there is no authenticated user.
  // Never derive a scope from model input — it is the tenant boundary.
  scope: (ctx) => ctx.session.auth.current?.principalId ?? ctx.session.id,
});
