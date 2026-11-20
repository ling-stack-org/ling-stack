import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LingServerPeerRegistry, SqliteLingServerStore } from "@ling-stack/core";
import type { LingServerInstallationV1, LingServerPeerBindingV1, LingServerRouteAttemptV1 } from "@ling-stack/contracts";

const MAX_BODY_BYTES = 256 * 1024;

export interface LingServerControlPlaneOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken: string;
  readonly now?: () => string;
  readonly registry?: LingServerPeerRegistry;
  readonly databasePath?: string;
  readonly store?: SqliteLingServerStore;
}

export class LingServerControlPlane {
  readonly registry: LingServerPeerRegistry;
  readonly #host: string;
  readonly #port: number;
  readonly #authToken: string;
  readonly #now: () => string;
  readonly #store?: SqliteLingServerStore;
  readonly #ownsStore: boolean;
  #storeClosed = false;
  #server?: Server;

  constructor(options: LingServerControlPlaneOptions) {
    if (!options.authToken.trim()) throw new Error("Ling Server control auth token is required");
    this.#store = options.store ?? (options.databasePath ? new SqliteLingServerStore({ databasePath: options.databasePath }) : undefined);
    this.#ownsStore = options.store === undefined && this.#store !== undefined;
    this.registry = options.registry ?? new LingServerPeerRegistry({ store: this.#store });
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#authToken = options.authToken;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.#server?.listening) return this.address();
    const server = createServer((request, response) => { void this.handleRequest(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => { server.off("error", reject); resolve(); });
    });
    this.#server = server;
    return this.address();
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    if (this.#ownsStore && !this.#storeClosed) {
      this.#store?.close();
      this.#storeClosed = true;
    }
  }

  address(): { readonly host: string; readonly port: number } {
    const address = this.#server?.address();
    return { host: this.#host, port: typeof address === "object" && address ? address.port : this.#port };
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? this.#host}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok", generatedAt: this.#now() });
      return;
    }
    if (!safeToken(request.headers.authorization, this.#authToken)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const body = request.method === "POST" ? await readJson(request) : undefined;
      if (request.method === "POST" && url.pathname === "/v1/installations") {
        writeJson(response, 200, this.registry.registerInstallation(requireBody< LingServerInstallationV1>(body)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/bindings") {
        writeJson(response, 200, this.registry.bindPeers(requireBody<LingServerPeerBindingV1>(body)));
        return;
      }
      const revoke = /^\/v1\/bindings\/([^/]+)\/revoke$/u.exec(url.pathname);
      if (request.method === "POST" && revoke) {
        const input = requireBody<{ readonly revision: number }>(body);
        writeJson(response, 200, this.registry.revokeBinding(decodeURIComponent(revoke[1]!), input.revision));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/routes") {
        const input = requireBody<{ readonly action: "begin" | "select" | "failover"; readonly route?: LingServerRouteAttemptV1; readonly routeAttemptId?: string; readonly selected?: "lan" | "direct" | "relay" }>(body);
        if (input.action === "begin" && input.route) writeJson(response, 200, this.registry.beginRoute(input.route));
        else if (input.action === "select" && input.routeAttemptId && input.selected) writeJson(response, 200, this.registry.selectRoute(input.routeAttemptId, input.selected, this.#now()));
        else if (input.action === "failover" && input.routeAttemptId) writeJson(response, 200, this.registry.failoverRoute(input.routeAttemptId, this.#now()));
        else writeJson(response, 400, { error: "invalid_route_request" });
        return;
      }
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function safeToken(value: string | undefined, expected: string): boolean {
  return value === `Bearer ${expected}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireBody<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("request body must be an object");
  return value as T;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}
