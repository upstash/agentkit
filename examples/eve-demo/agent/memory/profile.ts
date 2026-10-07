import { redisDocuments } from "@upstash/agentkit-eve/memory";
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

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
  // Scope memory to the authenticated principal. `byPrincipal` fails **closed**: it returns null
  // for anonymous/runtime callers, which disables the slot rather than pooling everyone into one
  // partition — unlike a `?? ctx.session.id` fallback, which silently degrades the boundary.
  // Here the principal comes from `demoUserAuth` (the `x-user-id` header from the UI's dropdown),
  // which runs before `localDev()` in agent/channels/eve.ts, so alice and bob stay separate in the
  // browser while the eve TUI — which sends no header — gets the shared `local-dev` principal.
  // ⚠ That header is demo-only: anyone can set it. Never derive a scope from an unverified header
  // (or from model input) in production — the scope IS the tenant boundary.
  scope: byPrincipal,
});
