import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  DEFAULT_WORKSPACE_ID,
  type RunStore,
} from "@ling-stack/core";
import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteCapabilityV1,
} from "@ling-stack/contracts";
import type { RemoteReplyDispatcher } from "./dispatch-worker.js";
import { RemoteDispatchWorker } from "./dispatch-worker.js";
import { RemoteConversationFacade } from "./conversation-facade.js";
import { RemoteAccessError } from "./errors.js";
import {
  createRemoteGatewayIdentity,
  RemotePairingAuthService,
} from "./pairing-auth-service.js";
import { RemoteProjectionOutboxWorker } from "./projection-outbox-worker.js";
import { RemoteGatewaySession } from "./session.js";
import { RemoteAccessStateStore } from "./state-store.js";

const LOOPBACK_HOST = "127.0.0.1";
const MANAGEMENT_PREFIX = "/v1/mobile-access";

export interface RemoteAccessControllerOptions {
  readonly store: RunStore;
  readonly stateDir: string;
  readonly listenerPort: number;
  readonly workspaceDisplayName: string;
  readonly managementCapability: string;
  readonly managementAllowedOrigins: readonly string[];
  readonly dispatcher?: RemoteReplyDispatcher;
  readonly now?: () => string;
}

export interface RemoteAccessStatus {
  readonly enabled: boolean;
  readonly listener: { readonly host: "127.0.0.1"; readonly port: number; readonly listening: boolean };
  readonly gatewayOrigin?: string;
  readonly gatewayId: string;
  readonly gatewayIdentityFingerprint: string;
  readonly pairedDevice?: {
    readonly deviceId: string;
    readonly displayName: string;
    readonly platform: "ios" | "android";
    readonly pairedAt: string;
  };
  readonly pairing: ReturnType<RemotePairingAuthService["pairingStatus"]>;
  readonly policyVersion: number;
  readonly workspaceBindingId: string;
  readonly sendEnabled: boolean;
}

export class RemoteAccessController {
  readonly csrfToken: string;
  private readonly now: () => string;
  private readonly stateStore: RemoteAccessStateStore;
  private readonly auth: RemotePairingAuthService;
  private remoteServer?: Server;
  private webSocketServer?: WebSocketServer;
  private activeSession?: RemoteGatewaySession;
  private pollTimer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;

  constructor(private readonly options: RemoteAccessControllerOptions) {
    if (!options.managementCapability.trim()) {
      throw new Error("Remote Access management capability is required");
    }
    if (options.managementAllowedOrigins.length === 0) {
      throw new Error("Remote Access requires at least one management Origin");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.csrfToken = createHash("sha256").update(`ling-mobile-csrf-v1:${options.managementCapability}`).digest("base64url");
    this.stateStore = new RemoteAccessStateStore({
      stateDir: options.stateDir,
      listenerPort: options.listenerPort,
      createIdentity: createRemoteGatewayIdentity,
      now: this.now,
    });
    this.auth = new RemotePairingAuthService({
      stateStore: this.stateStore,
      now: this.now,
      onSecurityStateChanged: (reason) => {
        if (reason === "disabled") {
          this.activeSession?.revoke("disabled");
        } else if (reason === "revoked") {
          this.activeSession?.revoke("revoked");
        }
      },
    });
  }

  async startIfEnabled(): Promise<void> {
    if (this.stateStore.hasState() && this.auth.state().enabled) {
      await this.startListener();
    }
  }

  async stop(): Promise<void> {
    this.stopPolling();
    this.activeSession?.revoke("disabled");
    this.activeSession = undefined;
    const server = this.remoteServer;
    const webSocketServer = this.webSocketServer;
    this.remoteServer = undefined;
    this.webSocketServer = undefined;
    webSocketServer?.close();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  status(): RemoteAccessStatus {
    const state = this.auth.state();
    const address = this.remoteServer?.address() as AddressInfo | null | undefined;
    return {
      enabled: state.enabled,
      listener: {
        host: LOOPBACK_HOST,
        port: address?.port ?? state.listenerPort,
        listening: Boolean(address),
      },
      ...(state.gatewayOrigin ? { gatewayOrigin: state.gatewayOrigin } : {}),
      gatewayId: this.auth.identity.gatewayId,
      gatewayIdentityFingerprint: this.auth.identity.publicKeyFingerprint,
      ...(state.pairedDevice ? {
        pairedDevice: {
          deviceId: state.pairedDevice.deviceId,
          displayName: state.pairedDevice.displayName,
          platform: state.pairedDevice.platform,
          pairedAt: state.pairedDevice.pairedAt,
        },
      } : {}),
      pairing: this.auth.pairingStatus(),
      policyVersion: state.policyVersion,
      workspaceBindingId: state.workspaceBindingId,
      sendEnabled: Boolean(this.options.dispatcher),
    };
  }

  async handleManagementRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.startsWith(MANAGEMENT_PREFIX)) {
      return false;
    }
    const origin = request.headers.origin;
    if (!origin || !this.options.managementAllowedOrigins.includes(origin)) {
      writeManagementJson(response, 403, { error: "origin_not_allowed", message: "A trusted management Origin is required." }, origin);
      return true;
    }
    setManagementCors(response, origin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return true;
    }
    if (!safeHeaderEquals(request.headers["x-ling-mobile-management-capability"], this.options.managementCapability)) {
      writeManagementJson(response, 401, { error: "capability_required", message: "Mobile Access management capability is invalid." }, origin);
      return true;
    }
    if (request.method !== "GET" && !safeHeaderEquals(request.headers["x-ling-csrf-token"], this.csrfToken)) {
      writeManagementJson(response, 403, { error: "csrf_invalid", message: "Mobile Access CSRF token is invalid." }, origin);
      return true;
    }
    try {
      if (url.pathname === `${MANAGEMENT_PREFIX}/status` && request.method === "GET") {
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/enable` && request.method === "POST") {
        const body = requireRecord(await readJson(request));
        const gatewayOrigin = requireString(body.gatewayOrigin, "gatewayOrigin");
        this.auth.enable(gatewayOrigin);
        await this.startListener();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/disable` && request.method === "POST") {
        this.auth.disable();
        await this.stop();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/start` && request.method === "POST") {
        const pairing = this.auth.beginPairing();
        writeManagementJson(response, 200, { ...pairing, status: this.status() }, origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/confirm` && request.method === "POST") {
        this.auth.confirmPendingPairing();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/pairing/reject` && request.method === "POST") {
        this.auth.rejectPendingPairing();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      if (url.pathname === `${MANAGEMENT_PREFIX}/revoke` && request.method === "POST") {
        this.auth.revokeDevice();
        writeManagementJson(response, 200, this.status(), origin);
        return true;
      }
      writeManagementJson(response, 404, { error: "not_found", message: "Mobile Access management route not found." }, origin);
      return true;
    } catch (error) {
      const statusCode = error instanceof RemoteAccessError ? 409 : 400;
      writeManagementJson(response, statusCode, {
        error: error instanceof RemoteAccessError ? error.code : "bad_request",
        message: error instanceof Error ? error.message : String(error),
      }, origin);
      return true;
    }
  }

  private async startListener(): Promise<void> {
    if (this.remoteServer?.listening) {
      return;
    }
    const state = this.auth.state();
    if (!state.enabled || !state.gatewayOrigin) {
      throw new Error("Remote Access must be enabled before starting the listener");
    }
    const server = createServer((request, response) => {
      void this.handleRemoteHttp(request, response).catch((error) => {
        if (!response.headersSent) {
          writeRemoteJson(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
        } else {
          response.end();
        }
      });
    });
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: REMOTE_PROTOCOL_LIMITS.maxFrameBytes });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/v1/session") {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const authenticationTimeout = setTimeout(() => webSocket.close(1008, "Authentication proof required."), 10_000);
        authenticationTimeout.unref();
        webSocket.once("message", (data, isBinary) => {
          clearTimeout(authenticationTimeout);
          if (isBinary) {
            webSocket.close(1008, "Authentication proof must be JSON.");
            return;
          }
          let proof: unknown;
          try {
            proof = JSON.parse(data.toString()) as unknown;
          } catch {
            webSocket.close(1008, "Authentication proof is invalid JSON.");
            return;
          }
          void this.auth.verifyAuthProof(proof).then((authenticated) => {
            this.activeSession?.revoke("replaced");
            const currentState = this.auth.state();
            const capabilities = this.capabilities();
            const facade = new RemoteConversationFacade({
              store: this.options.store,
              workspaceId: DEFAULT_WORKSPACE_ID,
              workspaceBindingId: currentState.workspaceBindingId,
              workspaceDisplayName: this.options.workspaceDisplayName,
              conversationAccess: currentState.conversationAccess,
              policyVersion: currentState.policyVersion,
              now: this.now,
            });
            const session = new RemoteGatewaySession({
              socket: webSocket,
              authenticated,
              gatewayId: this.auth.identity.gatewayId,
              facade,
              policy: facade.policySummary(capabilities),
              now: this.now,
              onMutation: () => this.scheduleDrain(),
              onClosed: (closed) => {
                if (this.activeSession === closed) {
                  this.activeSession = undefined;
                }
              },
            });
            this.activeSession = session;
            this.startPolling();
            this.scheduleDrain();
          }).catch((error) => {
            webSocket.close(1008, error instanceof Error ? error.message.slice(0, 120) : "Authentication failed.");
          });
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.listenerPort, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.remoteServer = server;
    this.webSocketServer = webSocketServer;
    this.startPolling();
  }

  private async handleRemoteHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setRemoteSecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/v1/health") {
      writeRemoteJson(response, 200, {
        ok: true,
        gatewayId: this.auth.identity.gatewayId,
        gatewayIdentityFingerprint: this.auth.identity.publicKeyFingerprint,
        protocolVersions: [1],
      });
      return;
    }
    if (request.method !== "POST") {
      writeRemoteJson(response, 405, { error: "method_not_allowed", message: "Remote Gateway accepts POST for this route." });
      return;
    }
    try {
      const body = await readJson(request);
      if (url.pathname === "/v1/pairing/challenge") {
        const input = requireRecord(body);
        writeRemoteJson(response, 200, this.auth.createPairingChallenge(requireString(input.pairingId, "pairingId")));
        return;
      }
      if (url.pathname === "/v1/pairing/proof") {
        const result = this.auth.submitPairingProof(body);
        writeRemoteJson(response, result.status === "accepted" ? 200 : 202, result);
        return;
      }
      if (url.pathname === "/v1/auth/challenge") {
        const input = requireRecord(body);
        writeRemoteJson(response, 200, this.auth.createAuthChallenge(requireString(input.deviceId, "deviceId")));
        return;
      }
      writeRemoteJson(response, 404, { error: "not_found", message: "Remote Gateway route not found." });
    } catch (error) {
      writeRemoteJson(response, error instanceof RemoteAccessError ? 403 : 400, {
        error: error instanceof RemoteAccessError ? error.code : "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private capabilities(): readonly RemoteCapabilityV1[] {
    return [
      "conversation.read",
      ...(this.options.dispatcher ? ["conversation.send_text" as const] : []),
      "conversation.mark_read",
      "profile.read",
      "profile.update",
    ];
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => this.scheduleDrain(), 250);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private scheduleDrain(): void {
    if (this.drainPromise) {
      return;
    }
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
  }

  private async drain(): Promise<void> {
    if (this.options.dispatcher) {
      const dispatchWorker = new RemoteDispatchWorker({
        store: this.options.store,
        dispatcher: this.options.dispatcher,
        workerId: `remote_gateway_${process.pid}`,
        now: this.now,
      });
      await dispatchWorker.drainBatch();
    }
    if (this.activeSession) {
      const facade = new RemoteConversationFacade({
        store: this.options.store,
        workspaceId: DEFAULT_WORKSPACE_ID,
        workspaceBindingId: this.auth.state().workspaceBindingId,
        workspaceDisplayName: this.options.workspaceDisplayName,
        conversationAccess: this.auth.state().conversationAccess,
        policyVersion: this.auth.state().policyVersion,
        now: this.now,
      });
      const worker = new RemoteProjectionOutboxWorker(this.options.store, facade, {
        publish: (event) => this.activeSession?.publish(event),
      }, this.now);
      await worker.drainUntilIdle();
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > REMOTE_PROTOCOL_LIMITS.maxFrameBytes) {
      throw new Error("Remote request is too large");
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeRemoteJson(response: ServerResponse, statusCode: number, body: unknown): void {
  setRemoteSecurityHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function setRemoteSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function writeManagementJson(response: ServerResponse, statusCode: number, body: unknown, origin?: string): void {
  if (origin) {
    setManagementCors(response, origin);
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function setManagementCors(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,X-Ling-Mobile-Management-Capability,X-Ling-CSRF-Token",
  );
}

function safeHeaderEquals(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}
