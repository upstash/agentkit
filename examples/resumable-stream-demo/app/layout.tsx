import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "Resumable stream demo" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Resumable streams on Upstash Redis</h1>
          {children}
        </main>
      </body>
    </html>
  );
}
