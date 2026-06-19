import Link from "next/link";
import { demos } from "../lib/demos";

export default function Nav() {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800 sticky top-0 z-10 bg-background/80 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold tracking-tight">
          🧰 Redis AgentKit
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        {demos.map((d) => (
          <Link
            key={d.slug}
            href={`/${d.slug}`}
            className="text-zinc-600 dark:text-zinc-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition"
          >
            {d.title}
          </Link>
        ))}
      </nav>
    </header>
  );
}
