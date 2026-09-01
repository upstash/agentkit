"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  rpc,
  TASKS_EXTENSION,
  TERMINAL,
  type Frame,
  type WireTask,
} from "./lib/mcp-client";

const TOOL_NAME = "generate_report";

type TrackedTask = {
  taskId: string;
  topic: string;
  startedAt: number;
  lastPolledAt: number;
  polls: number;
  wire: WireTask;
};

export default function Page() {
  const [topic, setTopic] = useState("coffee trends");
  const [tasks, setTasks] = useState<TrackedTask[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [tools, setTools] = useState<string[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const onFrame = useCallback((frame: Frame) => {
    setFrames(previous => [frame, ...previous].slice(0, 80));
  }, []);

  // A plain `tools/list` — the task tool is an ordinary MCP tool. Nothing about its declaration
  // says "task"; the server decides per call whether to answer with a handle.
  useEffect(() => {
    rpc<{ tools: { name: string }[] }>("tools/list", {}, { onFrame })
      .then(result => setTools(result.tools.map(tool => tool.name)))
      .catch(cause => setError(String(cause)));
  }, [onFrame]);

  // Re-render once a second so the elapsed counters move.
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const tasksRef = useRef<TrackedTask[]>(tasks);
  tasksRef.current = tasks;

  // The client polls; the server has nothing to push. Each task carries its own
  // `pollIntervalMs`, so the server sets the pace rather than the UI guessing.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      for (const task of tasksRef.current) {
        if (TERMINAL.has(task.wire.status)) continue;
        if (now - task.lastPolledAt < (task.wire.pollIntervalMs ?? 2000)) continue;
        markPolled(task.taskId);
        void poll(task.taskId);
      }
    }, 400);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function markPolled(taskId: string) {
    setTasks(previous =>
      previous.map(task => (task.taskId === taskId ? { ...task, lastPolledAt: Date.now() } : task)),
    );
  }

  async function poll(taskId: string) {
    try {
      const wire = await rpc<WireTask>("tasks/get", { taskId }, { onFrame });
      setTasks(previous =>
        previous.map(task =>
          task.taskId === taskId ? { ...task, wire, polls: task.polls + 1 } : task,
        ),
      );
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (!topic.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      // A normal `tools/call`. Because the request declared the tasks extension in its
      // capabilities, the server answers with a handle instead of blocking for ten seconds.
      const wire = await rpc<WireTask>(
        "tools/call",
        { name: TOOL_NAME, arguments: { topic: topic.trim() } },
        { onFrame },
      );
      setTasks(previous => [
        {
          taskId: wire.taskId,
          topic: topic.trim(),
          startedAt: Date.now(),
          lastPolledAt: Date.now(),
          polls: 0,
          wire,
        },
        ...previous,
      ]);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setStarting(false);
    }
  }

  async function cancel(taskId: string) {
    try {
      await rpc("tasks/cancel", { taskId }, { onFrame });
      await poll(taskId);
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <>
      <header className="masthead">
        <h1>MCP Tasks on Upstash</h1>
        <p>
          A long-running MCP tool that returns a task handle instead of blocking. The task record
          lives in Upstash Redis, the work runs through QStash, and this page is the client doing
          nothing but stateless JSON-RPC — no initialize handshake, no session id.
        </p>
        <div style={{ marginTop: 12 }}>
          <span className="pill">{TASKS_EXTENSION}</span>
          <span className="pill">2026-07-28</span>
          <span className="pill">
            tools/list → {tools ? (tools.join(", ") || "none") : "…"}
          </span>
        </div>
      </header>

      {error ? <div className="banner">{error}</div> : null}

      <div className="grid">
        <section>
          <div className="panel">
            <h2>Call the tool</h2>
            <div className="panel-body">
              <form className="launch" onSubmit={start}>
                <input
                  type="text"
                  value={topic}
                  onChange={event => setTopic(event.target.value)}
                  placeholder="a topic to report on"
                  aria-label="Report topic"
                />
                <button type="submit" disabled={starting || !topic.trim()}>
                  {starting ? "Creating…" : "Run tool"}
                </button>
              </form>
              <p className="hint">
                <code className="inline-code">generate_report</code> takes four steps of about 2.5
                seconds and checks for cancellation between them.
              </p>
            </div>
          </div>

          <div className="tasks">
            {tasks.length === 0 ? (
              <p className="empty">No tasks yet. Run the tool to create one.</p>
            ) : (
              tasks.map(task => (
                <TaskCard key={task.taskId} task={task} onCancel={() => cancel(task.taskId)} />
              ))
            )}
          </div>

          <div className="callout">
            <h3>Prove the work is durable, not just the record</h3>
            <p>
              Start a task, then kill the dev server mid-run and start it again. The Redis record
              was never in doubt — but the QStash delivery that died with the process is retried
              against the new one, so the task still reaches <code>completed</code>. Swap QStash for
              a fire-and-forget promise and the same test leaves a perfectly durable record of a
              task stuck in <code>working</code> until its TTL expires.
            </p>
          </div>
        </section>

        <section className="panel">
          <h2>
            <span>Wire log</span>
            <button className="ghost" onClick={() => setFrames([])} disabled={frames.length === 0}>
              clear
            </button>
          </h2>
          <div className="log">
            {frames.length === 0 ? (
              <p className="empty" style={{ padding: "0 16px" }}>
                Nothing sent yet.
              </p>
            ) : (
              frames.map(frame => <FrameRow key={frame.id} frame={frame} />)
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function TaskCard({ task, onCancel }: { task: TrackedTask; onCancel: () => void }) {
  const { wire } = task;
  const done = TERMINAL.has(wire.status);
  const elapsed = Math.round(((done ? Date.parse(wire.lastUpdatedAt) : Date.now()) - task.startedAt) / 1000);
  const progress = readProgress(wire);

  return (
    <article className="task">
      <div className="task-head">
        <span className="task-topic">{task.topic}</span>
        <span className="task-id">{wire.taskId.slice(0, 8)}…</span>
        <span className="spacer" />
        <span className={`badge ${wire.status}`}>{wire.status}</span>
        {done ? null : (
          <button className="ghost" onClick={onCancel}>
            cancel
          </button>
        )}
      </div>

      <p className="status-line">{wire.statusMessage ?? "—"}</p>

      <div className={`bar ${wire.status}`}>
        <span style={{ width: `${done && wire.status === "completed" ? 100 : progress}%` }} />
      </div>

      <div className="meta">
        <span>{elapsed}s elapsed</span>
        <span>{task.polls} polls</span>
        <span>ttl {wire.ttlMs === null ? "∞" : `${Math.round(wire.ttlMs / 1000)}s`}</span>
        <span>every {wire.pollIntervalMs ?? 2000}ms</span>
      </div>

      {wire.result ? (
        <div className="result">
          <p>Result, carried inline on the final poll:</p>
          <pre>{JSON.stringify(wire.result, null, 2)}</pre>
        </div>
      ) : null}

      {wire.error ? (
        <div className="result">
          <p>Failed:</p>
          <pre>{JSON.stringify(wire.error, null, 2)}</pre>
        </div>
      ) : null}
    </article>
  );
}

function FrameRow({ frame }: { frame: Frame }) {
  return (
    <div className="frame">
      <div className="frame-head">
        <span className={`dir ${frame.direction === "in" ? "in" : ""}`}>
          {frame.direction === "out" ? "→" : "←"}
        </span>
        <span className="method">{frame.method}</span>
        <span className="time">{new Date(frame.at).toLocaleTimeString()}</span>
      </div>
      <pre>{JSON.stringify(frame.payload)}</pre>
    </div>
  );
}

/** The demo handler reports `Step n/4`, which is enough to drive a progress bar. */
function readProgress(wire: WireTask): number {
  if (wire.status === "completed") return 100;
  const match = /Step (\d+)\/(\d+)/.exec(wire.statusMessage ?? "");
  if (!match) return wire.status === "working" ? 4 : 0;
  const [, step, total] = match;
  return Math.round((Number(step) / Number(total)) * 100);
}
