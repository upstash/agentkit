"use client";

import { useState } from "react";

export interface StepLog {
  label: string;
  detail: string;
}

export interface DemoResponse {
  ok: boolean;
  summary?: string;
  steps?: StepLog[];
  data?: unknown;
  error?: string;
}

interface DemoConsoleProps {
  endpoint: string;
  presets: string[];
  placeholder?: string;
  /** Hint shown under the input, e.g. "Try sending the same question twice." */
  hint?: string;
}

export default function DemoConsole({ endpoint, presets, placeholder, hint }: DemoConsoleProps) {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("demo-session");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<{ input: string; res: DemoResponse }[]>([]);

  async function run(value: string) {
    const text = value.trim();
    if (!text || loading) return;
    setLoading(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text, sessionId }),
      });
      const json: DemoResponse = await res.json();
      setHistory((h) => [{ input: text, res: json }, ...h]);
      setInput("");
    } catch (err) {
      setHistory((h) => [
        { input: text, res: { ok: false, error: String(err) } },
        ...h,
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => run(p)}
            disabled={loading}
            className="rounded-full border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition"
          >
            {p}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder ?? "Type something…"}
            className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition"
          >
            {loading ? "Running…" : "Run"}
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>session:</span>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-0.5"
          />
          {hint && <span className="ml-auto italic">{hint}</span>}
        </div>
      </form>

      <div className="flex flex-col gap-3">
        {history.map((entry, i) => (
          <ResultCard key={history.length - i} input={entry.input} res={entry.res} />
        ))}
      </div>
    </div>
  );
}

function ResultCard({ input, res }: { input: string; res: DemoResponse }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-4 text-sm">
      <div className="mb-2 font-mono text-xs text-zinc-500">▶ {input}</div>
      {res.error ? (
        <div className="text-red-500">Error: {res.error}</div>
      ) : (
        <>
          {res.summary && <div className="mb-3 font-medium">{res.summary}</div>}
          {res.steps && res.steps.length > 0 && (
            <ol className="mb-3 flex flex-col gap-1.5 border-l-2 border-emerald-500/40 pl-3">
              {res.steps.map((s, idx) => (
                <li key={idx} className="flex flex-col">
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    {s.label}
                  </span>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
                    {s.detail}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {res.data !== undefined && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-500">raw data</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 dark:bg-zinc-800 p-2">
                {JSON.stringify(res.data, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
