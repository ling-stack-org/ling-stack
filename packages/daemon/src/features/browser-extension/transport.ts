import type { Socket } from "node:net";
import { WebSocket, type RawData } from "ws";
import { CHROME_BROWSER_MAX_MESSAGE_BYTES, type ChromeBrowserTransportKind } from "@ling-stack/contracts";

export interface ChromeBrowserSessionTransport {
  readonly kind: ChromeBrowserTransportKind;
  isOpen(): boolean;
  send(message: string): Promise<void>;
  close(code: number, reason: string): void;
  terminate(): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: () => void): () => void;
}

export function createChromeBrowserWebSocketTransport(socket: WebSocket): ChromeBrowserSessionTransport {
  return {
    kind: "legacy_websocket",
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (message) => new Promise<void>((resolve, reject) => {
      socket.send(message, (error) => error ? reject(error) : resolve());
    }),
    close: (code, reason) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason.slice(0, 123));
      }
    },
    terminate: () => socket.terminate(),
    onMessage: (listener) => bindWebSocket(socket, "message", (data) => {
      if (rawDataBytes(data) > CHROME_BROWSER_MAX_MESSAGE_BYTES) {
        socket.close(4002, "chrome_browser_protocol_invalid");
        return;
      }
      listener(rawDataText(data));
    }),
    onClose: (listener) => bindWebSocket(socket, "close", listener),
    onError: (listener) => bindWebSocket(socket, "error", listener),
  };
}

export function createChromeBrowserNativeSocketTransport(socket: Socket): ChromeBrowserSessionTransport {
  const messageListeners = new Set<(message: string) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<() => void>();
  let buffered = Buffer.alloc(0);
  let open = true;
  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || length > CHROME_BROWSER_MAX_MESSAGE_BYTES) {
        open = false;
        socket.destroy(new Error("chrome_native_frame_invalid"));
        return;
      }
      if (buffered.length < 4 + length) return;
      const payload = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      const message = payload.toString("utf8");
      for (const listener of [...messageListeners]) listener(message);
    }
  });
  socket.on("close", () => {
    open = false;
    if (buffered.length > 0) for (const listener of [...errorListeners]) listener();
    for (const listener of [...closeListeners]) listener();
  });
  socket.on("error", () => {
    for (const listener of [...errorListeners]) listener();
  });
  return {
    kind: "native_messaging",
    isOpen: () => open && !socket.destroyed && socket.writable,
    send: async (message) => {
      const payload = Buffer.from(message, "utf8");
      if (payload.length === 0 || payload.length > CHROME_BROWSER_MAX_MESSAGE_BYTES) {
        throw new Error("chrome_native_frame_invalid");
      }
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      await new Promise<void>((resolve, reject) => {
        socket.write(frame, (error) => error ? reject(error) : resolve());
      });
    },
    close: (_code, _reason) => {
      open = false;
      socket.end();
    },
    terminate: () => {
      open = false;
      socket.destroy();
    },
    onMessage: (listener) => bindSet(messageListeners, listener),
    onClose: (listener) => bindSet(closeListeners, listener),
    onError: (listener) => bindSet(errorListeners, listener),
  };
}

function bindSet<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

function bindWebSocket<Event extends "message" | "close" | "error">(
  socket: WebSocket,
  event: Event,
  listener: Event extends "message" ? (data: RawData) => void : () => void,
): () => void {
  socket.on(event, listener as never);
  return () => socket.off(event, listener as never);
}

function rawDataText(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function rawDataBytes(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}
