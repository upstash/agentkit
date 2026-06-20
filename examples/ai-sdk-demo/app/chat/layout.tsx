import Sidebar from "../components/Sidebar";

// The sidebar lives in the layout (not the page), so it stays mounted as you switch chats —
// its search box and list state survive navigation instead of remounting on every `[id]` change.
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="layout">
      <Sidebar />
      <section className="chat-pane">{children}</section>
    </div>
  );
}
