"use client";

import { useState } from "react";
import { AgentChat, USERS } from "./agent-chat";

/**
 * Holds the selected demo user and remounts the chat (via `key`) when it changes, so switching users
 * starts a fresh eve session whose memory / cached tools are scoped to that user (the `x-user-id`
 * header set in agent/channels/eve.ts).
 */
export function UserChat() {
  const [userId, setUserId] = useState<string>(USERS[0]);
  return <AgentChat key={userId} userId={userId} onSwitchUser={setUserId} />;
}
