/**
 * A hand-rolled MCP client for the browser.
 *
 * The official `@modelcontextprotocol/client` validates `tools/call` responses against its own
 * result schemas, which do not yet accept the tasks extension's `resultType: "task"` discriminator
 * — so a task handle comes back as a validation error rather than a handle. Until that lands,
 * talking raw JSON-RPC is the honest way to demo the extension, and it has the side benefit of
 * showing exactly what a stateless MCP request looks like now.
 */
export const PROTOCOL_VERSION = "2026-07-28";
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_ENDPOINT = "/api/mcp";

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
};

/**
 * Sends one stateless JSON-RPC request.
 *
 * There is no initialize handshake and no session header any more: the protocol version, who the
 * client is, and which extensions it supports all ride in `_meta` on every single request. The
 * server reads the capabilities from there to decide whether it may answer a tool call with a
 * task handle.
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
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { [TASKS_EXTENSION]: {} },
        },
      },
    },
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  // The spec routes on a name header so a load balancer never has to parse the body: the tool
  // name for a call, the task id for the task methods.
  if (method === "tools/call" && typeof params.name === "string") headers["mcp-name"] = params.name;
  if (method.startsWith("tasks/") && typeof params.taskId === "string") {
    headers["mcp-name"] = params.taskId;
  }

  options.onFrame?.({ id: ++frameId, direction: "out", method, payload: body, at: Date.now() });

  const response = await fetch(MCP_ENDPOINT, {
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
