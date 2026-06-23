"use client";
import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_USER, USER_COOKIE, USERS, type DemoUser, normalizeUser } from "../lib/users";

type UserContextValue = {
  /** The currently selected demo user. */
  userId: DemoUser;
  /** Switch users: persist the choice, start a fresh chat, and re-render server components. */
  switchUser: (next: DemoUser) => void;
};

const UserContext = createContext<UserContextValue | null>(null);

/**
 * Holds the selected demo user. Initialized from the cookie (server-read, passed in to avoid a
 * hydration mismatch). Switching writes the cookie — so the server can scope the chat page's initial
 * transcript — and navigates to a fresh chat for the new user.
 */
export function UserProvider({
  initialUserId,
  children,
}: {
  initialUserId: DemoUser;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [userId, setUserId] = useState<DemoUser>(normalizeUser(initialUserId));

  const switchUser = useCallback(
    (next: DemoUser) => {
      if (next === userId) return;
      document.cookie = `${USER_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      setUserId(next);
      // Fresh chat for the new user; refresh so server components re-read the cookie.
      router.push(`/chat/${crypto.randomUUID()}`);
      router.refresh();
    },
    [userId, router],
  );

  return <UserContext.Provider value={{ userId, switchUser }}>{children}</UserContext.Provider>;
}

export function useUser(): UserContextValue {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within a UserProvider");
  return ctx;
}

export { USERS, DEFAULT_USER };
