import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "MCP Tasks on Upstash",
  description:
    "Durable long-running MCP tools: a task record in Upstash Redis, execution on QStash.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
