/**
 * A hand-rolled MCP client for the browser.
 *
 * It only ever sends `tools/list` and `tools/call` — the three task tools are ordinary MCP tools,
 * which is the point: any client, including ones that declare no extensions at all, can drive
 * them. Raw JSON-RPC is used so the wire log shows exactly what a stateless MCP request looks like.
 */
export const PROTOCOL_VERSION = "2026-07-28";
/** The two servers this demo runs: same tool, different execution transport. */
export const SERVERS = {
  qstash: { endpoint: "/api/mcp", label: "QStash", blurb: "one delivery, one invocation" },
  workflow: {
    endpoint: "/api/mcp-workflow",
    label: "Workflow",
    blurb: "one invocation per step, replayed from a journal",
  },
} as const;

export type ServerKey = keyof typeof SERVERS;

export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type WireTask = {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** One direction of one JSON-RPC exchange, for the wire log. */
export type Frame = {
  id: number;
  direction: "out" | "in";
  method: string;
  payload: unknown;
  at: number;
};

let frameId = 0;
let requestId = 0;

export type RpcOptions = {
  /** Called once for the request and once for the response, so the UI can render the wire. */
  onFrame?: (frame: Frame) => void;
  /** Which of the two servers to talk to. Defaults to the QStash one. */
  server?: ServerKey;
};

/**
 * Sends one stateless JSON-RPC request.
 *
 * There is no initialize handshake and no session header any more: the protocol version, who the
 * client is, and its capabilities all ride in `_meta` on every single request. This client
 * declares no capabilities — the task tools need none.
 */
export async function rpc<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<T> {
  const body = {
    jsonrpc: "2.0" as const,
    id: ++requestId,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "mcp-tasks-demo", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  // The spec routes on a name header so a load balancer never has to parse the body.
  if (method === "tools/call" && typeof params.name === "string") headers["mcp-name"] = params.name;

  options.onFrame?.({ id: ++frameId, direction: "out", method, payload: body, at: Date.now() });

  const response = await fetch(SERVERS[options.server ?? "qstash"].endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const message = await readMessage(response);
  options.onFrame?.({
    id: ++frameId,
    direction: "in",
    method,
    payload: message,
    at: Date.now(),
  });

  if (message?.error) throw new RpcError(method, message.error);
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  return message?.result as T;
}

/**
 * Calls a tool and returns its `structuredContent` — for the task tools, the task object.
 * A tool-level error (`isError: true`) is thrown, with its text as the message.
 */
export async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<T> {
  const result = await rpc<{
    content?: { type: string; text?: string }[];
    structuredContent?: T;
    isError?: boolean;
  }>("tools/call", { name, arguments: args }, options);
  if (result.isError) {
    throw new Error(result.content?.map(part => part.text).join(" ") ?? `${name} failed`);
  }
  return result.structuredContent as T;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: { code?: number; message?: string; data?: unknown },
  ) {
    super(`${method}: ${rpcError?.message ?? "unknown error"}`);
    this.name = "RpcError";
  }
}

type JsonRpcResponse = { result?: unknown; error?: { code?: number; message?: string } } | undefined;

/**
 * Reads either shape the transport may answer with: a plain JSON body, or a one-message SSE
 * stream when the server decides to stream the response.
 */
async function readMessage(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text) return undefined;

  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(text) as JsonRpcResponse;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data) return JSON.parse(data) as JsonRpcResponse;
  }
  return undefined;
}
