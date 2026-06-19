import Link from "next/link";
import { demos } from "./lib/demos";

export default function Home() {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Redis AgentKit demos</h1>
        <p className="max-w-2xl text-zinc-600 dark:text-zinc-400">
          Each route below exercises one package of the kit against the same in-memory backends and a
          deterministic mock model — so the agent primitives (memory, history, semantic & tool
          caching, telemetry, sandbox, RAG) are observable without any credentials.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {demos.map((d) => (
          <Link
            key={d.slug}
            href={`/${d.slug}`}
            className="group flex flex-col gap-2 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-5 hover:border-emerald-500 hover:shadow-sm transition"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold group-hover:text-emerald-600 dark:group-hover:text-emerald-400">
                {d.title}
              </h2>
              <span className="text-zinc-400 group-hover:translate-x-0.5 transition">→</span>
            </div>
            <code className="text-xs text-emerald-700 dark:text-emerald-400">{d.pkg}</code>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{d.blurb}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
