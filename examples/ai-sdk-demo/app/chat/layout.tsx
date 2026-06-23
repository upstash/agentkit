import { cookies } from "next/headers";
import Sidebar from "../components/Sidebar";
import { UserProvider } from "../components/UserProvider";
import { USER_COOKIE, normalizeUser } from "../lib/users";

// The sidebar lives in the layout (not the page), so it stays mounted as you switch chats —
// its search box and list state survive navigation instead of remounting on every `[id]` change.
export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  // Read the selected user from the cookie so SSR (and the provider's initial state) match.
  const initialUserId = normalizeUser((await cookies()).get(USER_COOKIE)?.value);

  return (
    <UserProvider initialUserId={initialUserId}>
      <div className="layout">
        <Sidebar />
        <section className="chat-pane">{children}</section>
      </div>
    </UserProvider>
  );
}
