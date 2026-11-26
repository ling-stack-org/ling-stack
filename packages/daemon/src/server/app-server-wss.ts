import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { AppServerWssConfig } from "./app-server-wss-config.js";
import type { DaemonContext } from "../context.js";
import { attachRpcWebSocketServer } from "./rpc.js";

export function createAppServerWssListener(config: AppServerWssConfig, context: DaemonContext) {
  const server = createServer({
    key: readFileSync(config.privateKeyFile), cert: readFileSync(config.certificateFile), minVersion: "TLSv1.2",
  }, (_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("App Server WebSocket upgrade required.");
  });
  const allowedHosts = new Set(config.allowedHosts);
  const allowedOrigins = new Set(config.allowedOrigins);
  const permitsUpgrade = (request: IncomingMessage): boolean => {
    if (!request.headers.host || request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin)) return false;
    try {
      const host = new URL(`https://${request.headers.host}`);
      return allowedHosts.has(host.hostname) && !host.username && !host.password && host.pathname === "/" && !host.search && !host.hash;
    } catch { return false; }
  };
  const rpc = attachRpcWebSocketServer(server, context, { permitsRemoteUpgrade: permitsUpgrade });
  let shutdown: Promise<void> | undefined;
  return {
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    beginShutdown() {
      rpc.beginShutdown();
      shutdown ??= new Promise<void>((resolve, reject) => {
        if (!server.listening) resolve();
        else server.close(error => error ? reject(error) : resolve());
      });
      void shutdown.catch(() => undefined);
      return shutdown;
    },
    close() {
      rpc.close();
      server.closeAllConnections();
    },
  };
}
