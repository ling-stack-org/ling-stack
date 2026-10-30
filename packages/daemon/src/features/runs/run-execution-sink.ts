import type { ServerResponse } from "node:http";
import { setCorsHeaders, writeJson } from "../../shared/response.js";
import { SseStreamWriter } from "../../shared/sse-stream-writer.js";

export interface RunExecutionSink {
  readonly kind: "sse" | "detached";
  onClose(listener: () => void): void;
  isClosed(): boolean;
  writeReady(data: unknown): void;
  writeEvent(event: string, data: unknown): void;
  writeError(statusCode: number, body: unknown): void;
  end(): void;
}

/** Transport closure only retires this observer; the Host still owns its Run. */
export function createSseRunExecutionSink(response: ServerResponse): RunExecutionSink {
  let closed = Boolean(response.destroyed || response.writableEnded);
  let writer: SseStreamWriter | undefined;
  const closeListeners: (() => void)[] = [];
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    response.off("close", markClosed);
    for (const listener of closeListeners.splice(0)) listener();
  };
  if (!closed) response.on("close", markClosed);
  const ensureWriter = (): SseStreamWriter | undefined => {
    if (closed || response.destroyed || response.writableEnded) {
      markClosed();
      return undefined;
    }
    if (!writer) {
      setCorsHeaders(response);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      writer = new SseStreamWriter(response, { onClose: markClosed });
      // The first comment can itself return false, so it shares the same queue.
      writer.writeComment("ling-stack run stream");
    }
    return writer;
  };
  return {
    kind: "sse",
    onClose(listener) {
      if (closed) listener();
      else closeListeners.push(listener);
    },
    isClosed() { return closed; },
    writeReady(data) { ensureWriter()?.write("ready", data); },
    writeEvent(event, data) { ensureWriter()?.write(event, data); },
    writeError(statusCode, body) {
      if (closed || response.writableEnded || response.destroyed) return;
      if (!response.headersSent) {
        writeJson(response, statusCode, body);
        markClosed();
      } else {
        ensureWriter()?.write("error", body);
      }
    },
    end() {
      if (closed) return;
      if (writer) writer.finish();
      else {
        if (!response.writableEnded && !response.destroyed) response.end();
        markClosed();
      }
    },
  };
}

export function createDetachedRunExecutionSink(): RunExecutionSink {
  return {
    kind: "detached",
    onClose() {
      // Detached continuation runs are daemon-owned and have no browser stream.
    },
    isClosed() { return false; },
    writeReady() {},
    writeEvent() {},
    writeError() {},
    end() {},
  };
}
