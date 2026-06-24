// Two demo users you can switch between in the UI. Each user's data — chat history, agent memory,
// tool cache, and rate limit — is kept separate; only the shared books index is common to both.
export const USERS = ["alice", "bob"] as const;
export type DemoUser = (typeof USERS)[number];
export const DEFAULT_USER: DemoUser = "alice";

// The selected user is sent to the API on every request as this header, and persisted in this cookie
// so server components (the chat page's initial transcript) can read it on render.
export const USER_HEADER = "x-user-id";
export const USER_COOKIE = "demo-user-id";

/** Coerce an arbitrary header/cookie value to a known demo user (falls back to the default). */
export function normalizeUser(value: string | null | undefined): DemoUser {
  return USERS.includes(value as DemoUser) ? (value as DemoUser) : DEFAULT_USER;
}
