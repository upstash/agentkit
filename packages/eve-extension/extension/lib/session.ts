import type { SessionFrame } from "eve/tools";

/**
 * The part of eve's session context the extension reads: tool `ctx` and hook `ctx` both carry it,
 * so one `userId` function serves every contribution.
 */
export type SessionRef = Pick<SessionFrame, "session">;
