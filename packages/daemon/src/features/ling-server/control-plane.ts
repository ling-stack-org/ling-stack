import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import { DeviceFabricError, LingServerPeerRegistry, LingServerRelayCredentialIssuer, LingServerTransportPlanner, SqliteLingServerStore } from "@ling-stack/core";
import { REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, type LingServerInstallationV1, type LingServerPeerBindingV1, type LingServerRouteAttemptV1 } from "@ling-stack/contracts";
import { RemoteProtocolError } from "@ling-stack/remote-protocol";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { LingServerSignaling } from "./signaling.js";

const MAX_BODY_BYTES = 256 * 1024;

export interface LingServerControlPlaneOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authToken: string;
  readonly now?: () => string;
  readonly registry?: LingServerPeerRegistry;
  readonly databasePath?: string;
  readonly store?: SqliteLingServerStore;
  readonly tls?: Pick<ServerOptions, "cert" | "key">;
  readonly adminPort?: number;
  readonly transport?: {
    readonly protocolMajor?: number;
    readonly features?: readonly string[];
    readonly stunUrls?: readonly string[];
    readonly turnUrls?: readonly string[];
    readonly relaySharedSecret?: string | Uint8Array;
    readonly maxRelayCredentialTtlMs?: number;
    readonly maxActiveRelayCredentialsPerBinding?: number;
    readonly maxFrameBytes?: number;
  };
}

export class LingServerControlPlane {
  readonly registry: LingServerPeerRegistry;
  readonly #host: string;
  readonly #port: number;
  readonly #authToken: string;
  readonly #now: () => string;
  readonly #store?: SqliteLingServerStore;
  readonly #ownsStore: boolean;
  readonly #transportOptions: NonNullable<LingServerControlPlaneOptions["transport"]>;
  readonly #relayIssuer?: LingServerRelayCredentialIssuer;
  readonly #tls?: LingServerControlPlaneOptions["tls"];
  readonly #adminPort?: number;
  #storeClosed = false;
  #server?: HttpServer | HttpsServer;
  #adminServer?: HttpServer;
  #signaling?: LingServerSignaling;
  #signalExpiryTimer?: ReturnType<typeof setInterval>;

  constructor(options: LingServerControlPlaneOptions) {
    if (!options.authToken.trim()) throw new Error("Ling Server control auth token is required");
    this.#store = options.store ?? (options.databasePath ? new SqliteLingServerStore({ databasePath: options.databasePath }) : undefined);
    this.#ownsStore = options.store === undefined && this.#store !== undefined;
    this.registry = options.registry ?? new LingServerPeerRegistry({ store: this.#store });
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#authToken = options.authToken;
    this.#tls = options.tls;
    this.#adminPort = options.adminPort;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#transportOptions = options.transport ?? {};
    if (options.transport?.relaySharedSecret !== undefined) {
      this.#relayIssuer = new LingServerRelayCredentialIssuer({
        turnUrls: options.transport.turnUrls ?? [],
        sharedSecret: options.transport.relaySharedSecret,
        now: this.#now,
        maxTtlMs: options.transport.maxRelayCredentialTtlMs,
        maxActiveCredentialsPerBinding: options.transport.maxActiveRelayCredentialsPerBinding,
      });
    }
  }

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.#server?.listening) return this.address();
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void this.handleRequest(request, response, this.#adminPort === undefined);
    };
    const limits = { headersTimeout: 10_000, requestTimeout: 15_000 };
    const server = this.#tls ? createHttpsServer({ ...this.#tls, ...limits, minVersion: "TLSv1.2" }, handler)
      : createServer(limits, handler);
    const adminServer = this.#adminPort === undefined ? undefined : createServer(limits, (request, response) => {
      void this.handleRequest(request, response);
    });
    try {
      if (adminServer) await listen(adminServer, this.#adminPort!, "127.0.0.1");
      await listen(server, this.#port, this.#host);
    } catch (error) {
      if (adminServer) await closeServer(adminServer);
      await closeServer(server);
      throw error;
    }
    this.#server = server;
    this.#adminServer = adminServer;
    this.#signaling = new LingServerSignaling({
      registry: this.registry, protocolMajor: this.#transportOptions.protocolMajor ?? 1,
      features: [REMOTE_DEVICE_TASKS_SUBPROTOCOL_V4, ...(this.#transportOptions.features ?? [])],
      now: this.#now, relayIssuer: this.#relayIssuer,
      stunUrls: this.#transportOptions.stunUrls ?? [], turnUrls: this.#transportOptions.turnUrls ?? [],
    });
    this.#signalExpiryTimer = setInterval(() => this.#signaling?.purge(), 5_000);
    this.#signalExpiryTimer.unref();
    return this.address();
  }

  async stop(): Promise<void> {
    const server = this.#server;
    const adminServer = this.#adminServer;
    this.#server = undefined;
    this.#adminServer = undefined;
    clearInterval(this.#signalExpiryTimer);
    this.#signaling = undefined;
    await Promise.all([server ? closeServer(server) : undefined, adminServer ? closeServer(adminServer) : undefined]);
    if (this.#ownsStore && !this.#storeClosed) {
      this.#store?.close();
      this.#storeClosed = true;
    }
  }

  address(): { readonly host: string; readonly port: number } {
    const address = this.#server?.address();
    return { host: this.#host, port: typeof address === "object" && address ? address.port : this.#port };
  }

  adminAddress(): { readonly host: string; readonly port: number } | undefined {
    const bound = this.#adminServer?.address();
    return typeof bound === "object" && bound ? { host: bound.address, port: bound.port } : undefined;
  }

  async handleRequest(request: IncomingMessage, response: ServerResponse, admin = true): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, { status: "ok", generatedAt: this.#now() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/signaling/instance") {
      writeJson(response, 200, { instanceId: this.#signaling?.instanceId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/signaling") {
      await this.exchangeSignaling(request, response);
      return;
    }
    if (!admin) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!safeToken(request.headers.authorization, this.#authToken)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!allowLocalServiceRequest(request, response)) return;
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
        const revoked = this.registry.revokeBinding(decodeURIComponent(revoke[1]!), input.revision);
        this.#signaling?.purge();
        writeJson(response, 200, revoked);
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
      if (request.method === "POST" && url.pathname === "/v1/routes/transport-config") {
        const input = requireBody<{
          readonly bindingId: string;
          readonly routeAttemptId: string;
          readonly role: "gateway" | "mobile";
          readonly localKeyFingerprint: string;
          readonly remoteKeyFingerprint: string;
          readonly expiresAt: string;
        }>(body);
        if (Object.hasOwn(input, "relayCredential")) throw new Error("relay credentials are issued by the control plane");
        const binding = this.registry.requireActiveBinding(input.bindingId);
        const route = this.registry.requireRoute(input.routeAttemptId);
        const installation = this.registry.getInstallation(binding.installationId);
        if (!installation) throw new Error("installation is missing");
        const planner = new LingServerTransportPlanner({ installation, ...this.#transportOptions, now: this.#now, relayIssuer: this.#relayIssuer });
        writeJson(response, 200, planner.createConfig({ binding, route, role: input.role, localKeyFingerprint: input.localKeyFingerprint, remoteKeyFingerprint: input.remoteKeyFingerprint, expiresAt: input.expiresAt }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/routes/relay-credential") {
        const input = requireBody<{ readonly bindingId: string; readonly routeAttemptId: string; readonly role: "gateway" | "mobile"; readonly ttlMs?: number }>(body);
        const binding = this.registry.requireActiveBinding(input.bindingId);
        const route = this.registry.requireRoute(input.routeAttemptId);
        if (!this.#relayIssuer) throw new Error("relay credential issuer is not configured");
        writeJson(response, 200, this.#relayIssuer.issue({ binding, route, role: input.role, ttlMs: input.ttlMs }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/routes/diagnostics") {
        const input = requireBody<{
          readonly bindingId: string;
          readonly routeAttemptId: string;
          readonly diagnosticId: string;
          readonly checks: readonly { readonly id: "control_reachability" | "peer_presence" | "signaling" | "candidate_gathering" | "peer_handshake" | "cursor_resume" | "relay_quota" | "revocation"; readonly status: "pass" | "fail" | "unknown"; readonly code: string; readonly latencyMs?: number }[];
          readonly transportGeneration?: number;
          readonly localCandidateCount?: number;
          readonly remoteCandidateCount?: number;
          readonly requestedResumeSequence?: number;
          readonly replayedFrameCount?: number;
          readonly requiresSnapshot?: boolean;
          readonly generatedAt?: string;
        }>(body);
        const binding = this.registry.getBinding(input.bindingId);
        const route = this.registry.requireRoute(input.routeAttemptId);
        if (!binding) throw new Error("binding is missing");
        const installation = this.registry.getInstallation(binding.installationId);
        if (!installation) throw new Error("installation is missing");
        const planner = new LingServerTransportPlanner({ installation, ...this.#transportOptions, now: this.#now });
        writeJson(response, 200, planner.createDiagnostics({
          binding,
          route,
          diagnosticId: input.diagnosticId,
          checks: input.checks,
          transportGeneration: input.transportGeneration,
          localCandidateCount: input.localCandidateCount,
          remoteCandidateCount: input.remoteCandidateCount,
          requestedResumeSequence: input.requestedResumeSequence,
          replayedFrameCount: input.replayedFrameCount,
          requiresSnapshot: input.requiresSnapshot,
          generatedAt: input.generatedAt,
        }));
        return;
      }
      writeJson(response, 404, { error: "not_found" });
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async exchangeSignaling(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request).catch(() => undefined);
    if (body === undefined) {
      writeJson(response, 400, { error: "invalid_signaling_request" });
      return;
    }
    try {
      if (!this.#signaling) {
        writeJson(response, 503, { error: "signaling_unavailable" });
        return;
      }
      writeJson(response, 200, this.#signaling.exchange(body));
    } catch (error) {
      if (error instanceof RemoteProtocolError) writeJson(response, 400, { error: "invalid_signaling_request" });
      else if (error instanceof DeviceFabricError) {
        const status = error.code === "lease_busy" ? 429 : error.code === "revision_conflict" ? 409 : error.code === "resource_conflict" ? 503 : 403;
        writeJson(response, status, { error: status === 403 ? "signaling_denied" : status === 503 ? "signaling_unavailable" : error.code });
      } else writeJson(response, 503, { error: "signaling_unavailable" });
    }
  }
}

function listen(server: HttpServer | HttpsServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
}

function safeToken(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false;
  const provided = Buffer.from(value);
  const required = Buffer.from(`Bearer ${expected}`);
  return provided.length === required.length && timingSafeEqual(provided, required);
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
