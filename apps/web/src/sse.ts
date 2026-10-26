import type { RunEventEnvelope } from "./types.js";
import { LingDaemonTransportError } from "@ling-stack/api-client";

export type StreamMessage =
  | { readonly kind: "ready"; readonly runId: string }
  | { readonly kind: "event"; readonly event: RunEventEnvelope };

export type StreamJsonResponseParser<TResponse> = (value: unknown) => TResponse;

export async function streamRun<TResponse = never>(
  url: string,
  body: unknown,
  onMessage: (message: StreamMessage) => void,
  signal?: AbortSignal,
  parseJsonResponse?: StreamJsonResponseParser<TResponse>,
): Promise<TResponse | undefined> {
  try {
    await streamRunRpc(url, body, onMessage, signal);
    return undefined;
  } catch (error) {
    if (!(error instanceof RpcFallbackError)) {
      throw error;
    }
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("json")) {
    if (!parseJsonResponse) {
      throw new Error("Unexpected JSON response while starting a run stream.");
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Run admission response was not valid JSON.");
    }
    return parseJsonResponse(value);
  }
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`Unexpected run stream content type: ${contentType || "missing"}.`);
  }
  if (!response.body) {
    throw new Error("Run stream response did not include a body.");
  }

  await readSseResponse(response, (parsed) => {
    if (parsed.event === "ready") {
      const data = JSON.parse(parsed.data) as { runId?: unknown };
      if (typeof data.runId === "string") {
        onMessage({ kind: "ready", runId: data.runId });
      }
      return;
    }
    onMessage({ kind: "event", event: JSON.parse(parsed.data) as RunEventEnvelope });
  });
  return undefined;
}

class RpcFallbackError extends Error {}

async function streamRunRpc(
  runUrl: string,
  body: unknown,
  onMessage: (message: StreamMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cwd = readRunCwd(body);
  if (!cwd || typeof WebSocket === "undefined") {
    throw new RpcFallbackError("WebSocket RPC is not available.");
  }
  const ws = new WebSocket(rpcStreamUrl(runUrl, cwd));
  let accepted = false;
  let settled = false;
  let startResponseSeen = false;

  const close = (): void => {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };

  return await new Promise<void>((resolve, reject) => {
    const settleResolve = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      close();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      close();
      reject(error);
    };
    const abort = (): void => {
      settleReject(accepted ? new Error("Run stream was cancelled.") : new RpcFallbackError("WebSocket RPC was cancelled before run start."));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    signal?.addEventListener("abort", abort, { once: true });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { cwd } }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "runs.start", params: body }));
    });
    ws.addEventListener("message", (message) => {
      const envelope = parseRpcEnvelope(message.data);
      if (!envelope) {
        return;
      }
      if (envelope.id === 2) {
        startResponseSeen = true;
        if (envelope.error) {
          const code = readRpcErrorCode(envelope.error);
          settleReject(code === "method_not_found" || code === "not_initialized"
            ? new RpcFallbackError(envelope.error.message)
            : new Error(envelope.error.message));
          return;
        }
        accepted = true;
        return;
      }
      if (envelope.method !== "$/run_event") {
        return;
      }
      const params = envelope.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return;
      }
      const record = params as Record<string, unknown>;
      if (record.kind === "ready") {
        const data = record.data;
        if (data && typeof data === "object" && !Array.isArray(data) && typeof (data as { runId?: unknown }).runId === "string") {
          onMessage({ kind: "ready", runId: (data as { runId: string }).runId });
        }
        return;
      }
      if (record.kind === "event") {
        onMessage({ kind: "event", event: record.data as RunEventEnvelope });
        return;
      }
      if (record.kind === "error") {
        const body = record.body;
        const message = body && typeof body === "object" && !Array.isArray(body) && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : "Run failed before the stream started.";
        settleReject(accepted ? new Error(message) : new RpcFallbackError(message));
        return;
      }
      if (record.kind === "end") {
        settleResolve();
      }
    });
    ws.addEventListener("error", () => {
      settleReject(accepted ? new Error("WebSocket RPC stream failed.") : new RpcFallbackError("WebSocket RPC is unavailable."));
    });
    ws.addEventListener("close", () => {
      if (settled) {
        return;
      }
      settleReject(accepted || startResponseSeen ? new Error("WebSocket RPC stream closed.") : new RpcFallbackError("WebSocket RPC closed before run start."));
    });
  });
}

export async function readSseResponse(response: Response, onMessage: (message: { readonly event: string; readonly data: string }) => void): Promise<void> {
  if (!response.body) {
    throw new Error("Response did not include a stream body.");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  for (;;) {
    // Only reader IO is transport. Decoder/JSON/onMessage exceptions remain
    // protocol/business errors and must never be hidden by a Host stop banner.
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); }
    catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw new LingDaemonTransportError("stream-read", cause);
    }
    const { done, value } = chunk;
    if (done) {
      buffer += decoder.decode();
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        onMessage(parsed);
      }
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) {
        onMessage(parsed);
      }
    }
  }
}

function parseSseBlock(block: string): { event: string; data: string } | undefined {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join("\n") };
}

function rpcStreamUrl(runUrl: string, cwd: string): string {
  const url = new URL(runUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/rpc/stream";
  url.search = "";
  url.searchParams.set("cwd", cwd);
  return url.toString();
}

function readRunCwd(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const cwd = (body as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

function parseRpcEnvelope(data: unknown): {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly error?: { readonly message: string; readonly data?: unknown };
} | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as ReturnType<typeof parseRpcEnvelope>;
  } catch {
    return undefined;
  }
}

function readRpcErrorCode(error: { readonly data?: unknown }): string | undefined {
  const data = error.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readErrorMessage(response: Response): Promise<string> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    return friendlyErrorMessage(message);
  }
  return friendlyErrorMessage(message);
}

function friendlyErrorMessage(message: string): string {
  if ((message.includes("EACCES") || message.includes("ENOENT")) && message.includes(".ling-stack")) {
    return `Workspace path does not exist or is not writable. Use the absolute path to your local checkout. ${message}`;
  }
  return message;
}
