"use client";
import { useState } from "react";

export default function Console({ presets }: { presets: string[] }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<{ q: string; r: string }[]>([]);

  async function run(value: string) {
    const text = value.trim();
    if (!text || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: text }),
      });
      const json = await res.json();
      setLog((l) => [{ q: text, r: JSON.stringify(json, null, 2) }, ...l]);
      setInput("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: ".75rem" }}>
        {presets.map((p) => (
          <button key={p} onClick={() => run(p)} disabled={loading} style={{ background: "#e4e4e7", color: "#18181b", fontWeight: 400, fontSize: ".8rem" }}>
            {p}
          </button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); run(input); }} style={{ display: "flex", gap: ".5rem" }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message…" />
        <button type="submit" disabled={loading}>{loading ? "…" : "Run"}</button>
      </form>
      {log.map((e, i) => (
        <div className="card" key={log.length - i}>
          <div className="muted">▶ {e.q}</div>
          <div>{e.r}</div>
        </div>
      ))}
    </div>
  );
}
