import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Redis AgentKit — Demos",
  description:
    "Interactive demos of @upstash/agentkit — core SDK plus AI SDK, TanStack AI, LangChain, and Eve adapters.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Nav />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-4 text-center text-xs text-zinc-500">
          Backed by a real Upstash Redis (<code className="mx-1">Redis.fromEnv()</code>) with a mock
          model. Set <code className="mx-1">UPSTASH_REDIS_REST_URL</code> /
          <code className="mx-1">UPSTASH_REDIS_REST_TOKEN</code>; swap in a real model for production.
        </footer>
      </body>
    </html>
  );
}
