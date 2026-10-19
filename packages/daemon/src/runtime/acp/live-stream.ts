import { Readable, type Writable } from "node:stream";
import type { AnyMessage, JsonRpcId, Stream } from "@agentclientprotocol/sdk";
import { AcpLifecycleError, record, text } from "./live-errors.js";

export interface AcpReplyObservation {
  readonly requestId: JsonRpcId;
  readonly method: string;
  readonly outcome: "written" | "not_written" | "unknown";
}
interface IncomingRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  invoked: boolean;
  outcome?: AcpReplyObservation["outcome"];
}

export interface AcpLiveStreamOptions {
  readonly input: Writable;
  readonly output: Readable;
  readonly frameBytes?: number;
  readonly writeTimeoutMs?: number;
  readonly onReceive: (message: AnyMessage, responseMethod?: string) => void;
  readonly beforeWrite: (message: AnyMessage) => AnyMessage;
  readonly onSending: (message: AnyMessage) => void;
  readonly onWritten: (message: AnyMessage) => void;
  readonly onReplyOutcome?: (observation: AcpReplyObservation) => void;
  readonly onFailure: (error: AcpLifecycleError) => void;
}

/** Strict framing around the official SDK; no protocol payload is sent to its raw-error logger. */
export function createAcpLiveStream(options: AcpLiveStreamOptions): { stream: Stream; close(): void; retireReply(id: JsonRpcId): void } {
  const frameBytes = options.frameBytes ?? 8 * 1024 * 1024;
  const writeTimeoutMs = options.writeTimeoutMs ?? 30000;
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 128 || frameBytes > 32 * 1024 * 1024) throw new AcpLifecycleError("invalid_input");
  if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1 || writeTimeoutMs > 2 ** 30) throw new AcpLifecycleError("invalid_input");
  const outgoing = new Map<JsonRpcId, string>();
  const incoming = new Map<JsonRpcId, IncomingRequest>();
  const reader = Readable.toWeb(options.output).getReader();
  let pending = Buffer.alloc(0);
  let stopped = false;
  let released = false;
  let writing: { reject: (error: AcpLifecycleError) => void } | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => { if (!released) { released = true; reader.releaseLock(); } };
  const fail = (code: AcpLifecycleError["code"]): void => {
    if (!stopped) { options.onFailure(new AcpLifecycleError(code)); close(); }
  };
  const streamFailed = (): void => fail("connection_lost");
  function observe(entry: IncomingRequest, outcome: AcpReplyObservation["outcome"]): void {
    if (entry.outcome) return;
    entry.outcome = outcome;
    try {
      const result: unknown = options.onReplyOutcome?.({ requestId: entry.id, method: entry.method, outcome });
      if (record(result) && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new AcpLifecycleError("host_commit_failed");
      }
    }
    catch { fail("host_commit_failed"); }
  }
  function retireReply(id: JsonRpcId): void {
    const entry = incoming.get(id);
    if (entry) observe(entry, entry.invoked ? "unknown" : "not_written");
  }
  options.input.on("error", streamFailed).on("finish", streamFailed).on("close", streamFailed);
  options.output.on("error", streamFailed);
  function close(): void {
    if (stopped) return;
    stopped = true;
    pending = Buffer.alloc(0);
    outgoing.clear();
    for (const entry of incoming.values()) observe(entry, entry.invoked ? "unknown" : "not_written");
    incoming.clear();
    clearTimeout(writeTimer);
    writing?.reject(new AcpLifecycleError("connection_lost")); writing = undefined;
    options.input.destroy(); options.output.destroy();
    void reader.cancel().catch(() => {}).finally(() => {
      release();
      options.input.off("error", streamFailed).off("finish", streamFailed).off("close", streamFailed);
      options.output.off("error", streamFailed);
    });
  }
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        try {
          while (!stopped) {
            const chunk = await reader.read();
            if (stopped) { controller.close(); return; }
            if (chunk.done) throw new AcpLifecycleError(pending.length ? "protocol_error" : "connection_lost");
            if (!(chunk.value instanceof Uint8Array)) throw new AcpLifecycleError("protocol_error");
            if (pending.length + chunk.value.byteLength > frameBytes) throw new AcpLifecycleError("output_limit");
            pending = Buffer.concat([pending, chunk.value]);
            const messages: { message: AnyMessage; responseMethod?: string }[] = [];
            for (let newline = pending.indexOf(10); newline !== -1; newline = pending.indexOf(10)) {
              const line = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              let value: unknown;
              try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
              catch { throw new AcpLifecycleError("protocol_error"); }
              const message = envelope(value);
              let responseMethod: string | undefined;
              if ("id" in message) {
                if ("method" in message) {
                  if (incoming.has(message.id) || incoming.size >= 64) throw new AcpLifecycleError("protocol_error");
                  incoming.set(message.id, { id: message.id, method: message.method, invoked: false });
                } else {
                  responseMethod = outgoing.get(message.id);
                  if (!responseMethod) throw new AcpLifecycleError("protocol_error");
                  outgoing.delete(message.id);
                }
              }
              messages.push({ message, responseMethod });
              if (messages.length > 512) throw new AcpLifecycleError("output_limit");
            }
            // Check the entire buffered batch before a preceding success becomes observable.
            for (const { message, responseMethod } of messages) {
              options.onReceive(message, responseMethod);
              if (stopped) return;
              controller.enqueue(message);
            }
            if (messages.length) return;
          }
          controller.close();
        } catch (error) {
          const safe = error instanceof AcpLifecycleError ? error : new AcpLifecycleError("connection_lost");
          fail(safe.code);
          controller.error(safe);
        }
      },
      cancel: close,
    }),
    writable: new WritableStream<AnyMessage>({
      async write(candidate) {
        try {
          if (stopped) throw new AcpLifecycleError("connection_lost");
          const message = envelope(options.beforeWrite(candidate));
          if (stopped) throw new AcpLifecycleError("connection_lost");
          const encoded = `${JSON.stringify(message)}\n`;
          if (Buffer.byteLength(encoded) > frameBytes) throw new AcpLifecycleError("output_limit");
          if ("id" in message && "method" in message) {
            if (outgoing.has(message.id) || outgoing.size >= 64) throw new AcpLifecycleError("protocol_error");
            outgoing.set(message.id, message.method);
          }
          const reply = "id" in message && !("method" in message) ? incoming.get(message.id) : undefined;
          if ("id" in message && !("method" in message) && (!reply || reply.invoked)) throw new AcpLifecycleError("protocol_error");
          await new Promise<void>((resolve, reject) => {
            writing = { reject };
            options.onSending(message);
            if (stopped) { reject(new AcpLifecycleError("connection_lost")); return; }
            if (reply) reply.invoked = true;
            writeTimer = setTimeout(() => fail("timeout"), writeTimeoutMs);
            options.input.write(encoded, error => {
              clearTimeout(writeTimer);
              if (error || stopped) { reject(new AcpLifecycleError("connection_lost")); return; }
              // Keep write ownership until its observation commits; observers may reenter/close.
              if (reply) observe(reply, "written");
              if (stopped) { reject(new AcpLifecycleError("connection_lost")); return; }
              if ("id" in message && !("method" in message)) incoming.delete(message.id);
              try { options.onWritten(message); writing = undefined; resolve(); }
              catch { reject(new AcpLifecycleError("host_commit_failed")); }
            });
          });
        } catch (error) {
          const safe = error instanceof AcpLifecycleError ? error : new AcpLifecycleError("connection_lost");
          fail(safe.code);
          throw safe;
        }
      },
      abort: close,
      close,
    }),
  };
  return { stream, close, retireReply };
}

function id(value: unknown): value is string | number {
  return text(value) || typeof value === "number" && Number.isSafeInteger(value);
}
function envelope(value: unknown): AnyMessage {
  if (!record(value) || value.jsonrpc !== "2.0") throw new AcpLifecycleError("protocol_error");
  if ("method" in value) {
    if (!text(value.method) || "result" in value || "error" in value || ("id" in value && !id(value.id))
      || ("params" in value && !record(value.params))) throw new AcpLifecycleError("protocol_error");
    return "id" in value ? { jsonrpc: "2.0", id: value.id as string | number, method: value.method, params: value.params }
      : { jsonrpc: "2.0", method: value.method, params: value.params };
  }
  if (!id(value.id) || "params" in value || ("result" in value) === ("error" in value)) throw new AcpLifecycleError("protocol_error");
  if ("result" in value) return { jsonrpc: "2.0", id: value.id, result: value.result };
  if (!record(value.error) || typeof value.error.code !== "number" || !Number.isSafeInteger(value.error.code)
    || typeof value.error.message !== "string") throw new AcpLifecycleError("protocol_error");
  return { jsonrpc: "2.0", id: value.id, error: { code: value.error.code, message: "Native ACP request failed." } };
}
