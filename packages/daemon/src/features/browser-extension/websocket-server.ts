import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import {
  chromeExtensionIdFromOrigin,
  type ChromeBrowserSessionController,
} from "./session-controller.js";
import { createChromeBrowserWebSocketTransport } from "./transport.js";

export interface ChromeBrowserWebSocketServerHandle {
  close(): void;
}

export function attachChromeBrowserWebSocketServer(input: {
  readonly server: Server;
  readonly controller: ChromeBrowserSessionController;
  readonly host: string;
  readonly port: number;
  readonly workspaceCwd: string;
}): ChromeBrowserWebSocketServerHandle {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let closed = false;
  const handleUpgrade: Parameters<Server["on"]>[1] = (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${input.host}:${input.port}`}`);
    if (url.pathname !== "/browser-extension/v1/connect") return;
    if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHostname(url.hostname)) {
      rejectUpgrade(socket, 403, "Loopback Chrome connection required");
      return;
    }
    const extensionId = chromeExtensionIdFromOrigin(request.headers.origin);
    if (!extensionId) {
      rejectUpgrade(socket, 403, "Trusted Chrome extension Origin required");
      return;
    }
    const cwd = url.searchParams.get("cwd");
    if (cwd !== input.workspaceCwd) {
      rejectUpgrade(socket, 403, "Chrome workspace authority mismatch");
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      try {
        input.controller.acceptLegacyTransport(cwd, extensionId, createChromeBrowserWebSocketTransport(webSocket));
      } catch {
        webSocket.close(4003, "chrome_connection_rejected");
      }
    });
  };
  input.server.on("upgrade", handleUpgrade);
  const close = (): void => {
    if (closed) return;
    closed = true;
    input.server.off("upgrade", handleUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
  input.server.once("close", close);
  return { close };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
