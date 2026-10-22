import { Readable, type Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AnyMessage, AnyResponse, JsonRpcId, Stream } from "@agentclientprotocol/sdk";
import { NativeConnectionError } from "./codex-connection.js";

/** The SDK's default NDJSON reader logs invalid payloads. Probes need strict, redacted framing. */
export function createAcpProbeStream(input: Writable, output: Readable): {
  readonly stream: Stream;
  flush(signal: AbortSignal): Promise<void>;
  readonly failure: NativeConnectionError | undefined;
} {
  const reader = Readable.toWeb(output).getReader();
  const pendingIds = new Set<JsonRpcId>();
  let pending = Buffer.alloc(0);
  let bytes = 0;
  let ended = false;
  let failure: NativeConnectionError | undefined;
  const writes: Promise<void>[] = [];
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        try {
          while (!ended) {
            const chunk = await reader.read();
            if (ended) return;
            if (chunk.done) {
              ended = true;
              reader.releaseLock();
              if (pending.length) throw new NativeConnectionError("protocol_error");
              throw new NativeConnectionError("process_failed");
            }
            if (!(chunk.value instanceof Uint8Array)) throw new NativeConnectionError("protocol_error");
            bytes += chunk.value.byteLength;
            if (bytes > 64 * 1024) throw new NativeConnectionError("output_limit");
            pending = Buffer.concat([pending, chunk.value]);
            const responses: AnyResponse[] = [];
            for (let newline = pending.indexOf(10); newline !== -1; newline = pending.indexOf(10)) {
              const line = pending.subarray(0, newline);
              pending = pending.subarray(newline + 1);
              let value: unknown;
              try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
              catch { throw new NativeConnectionError("protocol_error"); }
              responses.push(probeResponse(value, pendingIds));
            }
            // Validate the whole chunk before releasing a result followed by a bad frame.
            for (const response of responses) controller.enqueue(response);
            if (responses.length) return;
          }
        } catch (error) {
          failure ??= error instanceof NativeConnectionError ? error : new NativeConnectionError("process_failed");
          if (!ended) {
            ended = true;
            output.destroy();
            try { await reader.cancel(); } catch { /* Preserve the redacted transport failure. */ }
            reader.releaseLock();
          }
          controller.error(failure);
        }
      },
      async cancel() {
        if (ended) return;
        ended = true;
        pending = Buffer.alloc(0);
        // Node's Web adapter otherwise synthesizes ABORT_ERR for a successful local close.
        output.destroy();
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      },
    }),
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        if (!("id" in message) || !("method" in message)) throw new NativeConnectionError("protocol_error");
        pendingIds.add(message.id);
        const written = new Promise<void>((resolve, reject) => {
          input.write(`${JSON.stringify(message)}\n`, error => {
            if (error) reject(new NativeConnectionError("process_failed")); else resolve();
          });
        });
        writes.push(written);
        await written;
      },
    }),
  };
  return {
    stream,
    get failure() { return failure; },
    async flush(signal) {
      if (signal.aborted) throw new NativeConnectionError("cancelled");
      let aborted: () => void = () => {};
      const cancellation = new Promise<never>((_, reject) => {
        aborted = () => reject(new NativeConnectionError("cancelled"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([Promise.all(writes), cancellation]);
        await nextTurn();
        if (signal.aborted) throw new NativeConnectionError("cancelled");
        if (failure) throw failure;
        if (pending.length) throw new NativeConnectionError("protocol_error");
      } finally { signal.removeEventListener("abort", aborted); }
    },
  };
}

function probeResponse(value: unknown, pendingIds: Set<JsonRpcId>): AnyResponse {
  if (!record(value) || value.jsonrpc !== "2.0" || "method" in value || "params" in value
    || !(typeof value.id === "string" || typeof value.id === "number" || value.id === null)
    || !pendingIds.delete(value.id) || ("result" in value) === ("error" in value)) {
    throw new NativeConnectionError("protocol_error");
  }
  if ("result" in value) return { jsonrpc: "2.0", id: value.id, result: value.result };
  if (!record(value.error) || !Number.isSafeInteger(value.error.code) || typeof value.error.code !== "number"
    || typeof value.error.message !== "string") throw new NativeConnectionError("protocol_error");
  return { jsonrpc: "2.0", id: value.id, error: { code: value.error.code, message: "Native ACP request failed." } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
