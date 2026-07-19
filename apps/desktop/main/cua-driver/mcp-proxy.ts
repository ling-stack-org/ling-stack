import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  cuaDriverProxyTokenMaterialV1,
  cuaDriverWorkspaceBindingMaterialV1,
} from "@ling-stack/contracts";
import type {
  CuaDriverProviderHost,
  JsonRpcClientMessage,
  JsonRpcResponse,
} from "./provider-host.js";
import {
  CuaDriverProviderHostError,
  parseClientJsonRpcMessage,
} from "./provider-host.js";
import type { CuaDriverTelemetrySink } from "./telemetry.js";
import { createCuaDriverTelemetry } from "./telemetry.js";

export const CUA_DRIVER_PROXY_PATH = "/mcp" as const;
export const DEFAULT_CUA_DRIVER_PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface CuaDriverProxyContext {
  readonly bridgeToken: string;
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly desktopInstanceEpoch: number;
  readonly generation: number;
  readonly workspaceCwd: string;
}

export interface CuaDriverMcpProxyOptions {
  readonly host: CuaDriverProviderHost;
  readonly context: CuaDriverProxyContext;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly telemetry?: CuaDriverTelemetrySink;
  readonly onSessionClosed?: (reason: string) => void;
  readonly onManagedReadinessChanged?: (message: unknown) => void;
  /** Runs after initialize is validated and before the response is exposed. */
  readonly onInitialized?: () => void | Promise<void>;
}

export interface CuaDriverMcpProxyEndpoint {
  readonly url: string;
  readonly port: number;
  readonly authorizationToken: string;
  readonly generation: number;
}

export type CuaDriverMcpProxyPublicEndpoint = Pick<CuaDriverMcpProxyEndpoint, "generation">;

export function publicCuaDriverMcpProxyEndpoint(
  endpoint: CuaDriverMcpProxyEndpoint | undefined,
): CuaDriverMcpProxyPublicEndpoint | undefined {
  return endpoint ? { generation: endpoint.generation } : undefined;
}

export class CuaDriverMcpProxyError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "CuaDriverMcpProxyError";
  }
}

/** Derive a per-instance secret without persisting the endpoint or token. */
export function deriveCuaDriverProxyToken(input: CuaDriverProxyContext): string {
  if (!input.bridgeToken) {
    throw new CuaDriverMcpProxyError("proxy_context_invalid");
  }
  try {
    return createHmac("sha256", input.bridgeToken)
      .update(cuaDriverProxyTokenMaterialV1(input), "utf8")
      .digest("base64url");
  } catch {
    throw new CuaDriverMcpProxyError("proxy_context_invalid");
  }
}

export function deriveCuaDriverWorkspaceBinding(workspaceCwd: string): string {
  try {
    return createHash("sha256")
      .update(cuaDriverWorkspaceBindingMaterialV1(workspaceCwd), "utf8")
      .digest("base64url");
  } catch {
    throw new CuaDriverMcpProxyError("proxy_workspace_missing");
  }
}

/**
 * One-client loopback Streamable HTTP transport. It deliberately does not
 * interpret tool semantics; all non-reserved JSON-RPC messages pass through.
 */
export class CuaDriverMcpProxy {
  private readonly telemetry: CuaDriverTelemetrySink;
  private readonly maxBodyBytes: number;
  private readonly server: Server;
  private readonly token: string;
  private readonly sockets = new Set<Socket>();
  private endpointValue: CuaDriverMcpProxyEndpoint | undefined;
  private startPromise: Promise<CuaDriverMcpProxyEndpoint> | undefined;
  private closePromise: Promise<void> | undefined;
  private sessionId: string | undefined;
  private sessionInitialized = false;
  private sseResponse: ServerResponse | undefined;
  private removeHostListener: (() => void) | undefined;
  private closed = false;
  private callGateOpen = false;
  private closingEpoch = 0;

  constructor(private readonly options: CuaDriverMcpProxyOptions) {
    this.telemetry = options.telemetry ?? createCuaDriverTelemetry();
    this.maxBodyBytes = boundedPositive(options.maxBodyBytes, DEFAULT_CUA_DRIVER_PROXY_MAX_BODY_BYTES, 64 * 1024 * 1024);
    this.token = deriveCuaDriverProxyToken(options.context);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.removeHostListener = options.host.onServerMessage((message) => this.handleHostMessage(message));
  }

  get endpoint(): CuaDriverMcpProxyEndpoint | undefined {
    return this.endpointValue;
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Close synchronously before async lease/client/child revocation begins. */
  closeCallGate(reason = "revoked"): void {
    if (!this.callGateOpen) {
      return;
    }
    this.callGateOpen = false;
    this.telemetry.emit("info", "cua_driver.proxy.call_gate_closed", {
      generation: this.options.context.generation,
      reason,
    });
  }

  start(): Promise<CuaDriverMcpProxyEndpoint> {
    if (this.endpointValue) {
      return Promise.resolve(this.endpointValue);
    }
    if (this.closed) {
      return Promise.reject(new CuaDriverMcpProxyError("proxy_closed"));
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const pending = new Promise<CuaDriverMcpProxyEndpoint>((resolveEndpoint, rejectEndpoint) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        rejectEndpoint(new CuaDriverMcpProxyError("proxy_bind_failed", error.message));
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        if (this.closed) {
          rejectEndpoint(new CuaDriverMcpProxyError("proxy_closed"));
          return;
        }
        const address = this.server.address();
        if (!address || typeof address === "string") {
          rejectEndpoint(new CuaDriverMcpProxyError("proxy_bind_failed"));
          return;
        }
        const endpoint: CuaDriverMcpProxyEndpoint = {
          url: `http://127.0.0.1:${address.port}${CUA_DRIVER_PROXY_PATH}`,
          port: address.port,
          authorizationToken: this.token,
          generation: this.options.context.generation,
        };
        this.endpointValue = endpoint;
        this.telemetry.emit("info", "cua_driver.proxy.bound", { port: address.port, generation: endpoint.generation });
        resolveEndpoint(endpoint);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port ?? 0, "127.0.0.1");
    });
    this.startPromise = pending;
    void pending.finally(() => {
      if (this.startPromise === pending) {
        this.startPromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  close(reason = "shutdown"): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closingEpoch += 1;
    const pending = this.closeInternal(reason);
    this.closePromise = pending;
    void pending.catch(() => {
      if (this.closePromise === pending) {
        this.closePromise = undefined;
      }
    });
    return pending;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closed) {
        this.writeJson(response, 503, { error: "proxy_closed" });
        return;
      }
      if (!this.authenticate(request)) {
        this.writeJson(response, 401, { error: "proxy_unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (request.headers.origin !== undefined) {
        this.writeJson(response, 403, { error: "browser_origin_forbidden" });
        return;
      }
      if (request.url !== CUA_DRIVER_PROXY_PATH) {
        this.writeJson(response, 404, { error: "proxy_route_not_found" });
        return;
      }
      if (!this.contextHeadersMatch(request)) {
        this.writeJson(response, 409, { error: "proxy_generation_or_workspace_mismatch" });
        return;
      }
      const method = request.method?.toUpperCase();
      if (method === "POST") {
        await this.handlePost(request, response);
      } else if (method === "GET") {
        this.handleGet(request, response);
      } else if (method === "DELETE") {
        await this.handleDelete(request, response);
      } else {
        this.writeJson(response, 405, { error: "proxy_method_not_allowed" }, { allow: "GET, POST, DELETE" });
      }
    } catch (error) {
      if (response.destroyed) {
        return;
      }
      try {
        if (!response.headersSent) {
          const status = error instanceof CuaDriverProviderHostError && error.code === "request_timeout" ? 504 : 400;
          this.writeJson(response, status, { error: error instanceof Error ? error.message : "proxy_request_failed" });
        } else {
          response.destroy();
        }
      } catch {
        response.destroy();
      }
    }
  }

  private async handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readRequestBody(request, this.maxBodyBytes, this.options.requestTimeoutMs ?? 20_000);
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8")) as unknown;
    } catch {
      this.writeJson(response, 400, { error: "mcp_json_invalid" });
      return;
    }
    const message = parseClientJsonRpcMessage(value);
    const isInitialize = "method" in message && message.method === "initialize";
    const requestSessionId = readSessionId(request);
    if (isInitialize) {
      const initializeEpoch = this.closingEpoch;
      this.assertOpenEpoch(initializeEpoch);
      if (requestSessionId || this.sessionId || this.sessionInitialized) {
        this.writeJson(response, 409, { error: "mcp_second_initialize_forbidden" });
        return;
      }
      if (!("id" in message)) {
        this.writeJson(response, 400, { error: "mcp_initialize_requires_id" });
        return;
      }
      const responseValue = await this.options.host.exchange(message);
      this.assertOpenEpoch(initializeEpoch);
      if (!responseValue) {
        throw new CuaDriverMcpProxyError("mcp_initialize_response_missing");
      }
      try {
        await this.options.onInitialized?.();
      } catch (error) {
        await this.options.host.stop("readiness_failed").catch(() => undefined);
        throw error;
      }
      // Final async-boundary fence before the session and authorization
      // response become visible to the daemon.
      this.assertOpenEpoch(initializeEpoch);
      this.callGateOpen = true;
      this.sessionId = randomBytes(24).toString("base64url");
      this.sessionInitialized = true;
      this.writeJson(response, 200, responseValue, {
        "mcp-session-id": this.sessionId,
        "cache-control": "no-store",
      });
      return;
    }
    if (!this.callGateOpen) {
      this.writeJson(response, 503, { error: "mcp_call_gate_closed" });
      return;
    }
    if (!this.sessionId || !this.sessionInitialized || requestSessionId !== this.sessionId) {
      this.writeJson(response, 409, { error: "mcp_session_required" });
      return;
    }
    const responseValue = await this.options.host.exchange(message);
    if (responseValue === undefined) {
      response.writeHead(202, { "mcp-session-id": this.sessionId, "cache-control": "no-store" });
      response.end();
    } else {
      this.writeJson(response, 200, responseValue, { "mcp-session-id": this.sessionId, "cache-control": "no-store" });
    }
  }

  private handleGet(request: IncomingMessage, response: ServerResponse): void {
    if (!this.callGateOpen) {
      this.writeJson(response, 503, { error: "mcp_call_gate_closed" });
      return;
    }
    if (!this.sessionId || !this.sessionInitialized || readSessionId(request) !== this.sessionId) {
      this.writeJson(response, 409, { error: "mcp_session_required" });
      return;
    }
    if (this.sseResponse) {
      this.writeJson(response, 409, { error: "mcp_second_stream_forbidden" });
      return;
    }
    this.sseResponse = response;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "mcp-session-id": this.sessionId,
    });
    response.write(": ling-cua-driver\n\n");
    response.once("close", () => {
      if (this.sseResponse === response) {
        this.sseResponse = undefined;
        if (!this.closed) {
          this.invalidateSession("mcp_stream_closed");
          void this.options.host.stop("mcp_stream_closed").catch(() => undefined);
        }
      }
    });
  }

  private async handleDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.sessionId || readSessionId(request) !== this.sessionId) {
      this.writeJson(response, 409, { error: "mcp_session_required" });
      return;
    }
    this.invalidateSession("mcp_session_released");
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    await this.options.host.stop("mcp_session_released");
  }

  private authenticate(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const candidate = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : request.headers["x-ling-cua-driver-proxy-token"];
    if (typeof candidate !== "string" || candidate.length !== this.token.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token));
    } catch {
      return false;
    }
  }

  private contextHeadersMatch(request: IncomingMessage): boolean {
    const context = this.options.context;
    return request.headers["x-ling-cua-driver-generation"] === String(context.generation)
      && request.headers["x-ling-cua-driver-workspace-sha256"] === deriveCuaDriverWorkspaceBinding(context.workspaceCwd)
      && request.headers["x-ling-cua-driver-authority-epoch"] === context.daemonAuthorityEpoch
      && request.headers["x-ling-cua-driver-instance-epoch"] === String(context.desktopInstanceEpoch)
      && request.headers["x-ling-cua-driver-bridge-connection"] === context.bridgeConnectionId;
  }

  private handleHostMessage(message: unknown): void {
    if (isManagedReadinessChanged(message)) {
      try {
        // The native provider emits a JSON-RPC notification envelope; the
        // readiness controller validates the locked payload, not the envelope.
        this.options.onManagedReadinessChanged?.(
          isRecord(message) && Object.hasOwn(message, "params") ? message.params : message,
        );
      } catch {
        // Readiness listeners are advisory; protocol forwarding remains safe.
      }
      return;
    }
    if (!this.sseResponse || this.sseResponse.destroyed) {
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > this.maxBodyBytes) {
      this.invalidateSession("mcp_server_message_oversized");
      return;
    }
    this.sseResponse.write(`event: message\ndata: ${serialized}\n\n`);
  }

  private invalidateSession(reason: string): void {
    const hadSession = this.sessionId !== undefined;
    this.sessionId = undefined;
    this.sessionInitialized = false;
    this.closeCallGate(reason);
    if (this.sseResponse && !this.sseResponse.destroyed) {
      this.sseResponse.end();
    }
    this.sseResponse = undefined;
    if (hadSession) {
      this.telemetry.emit("info", "cua_driver.proxy.session_closed", { generation: this.options.context.generation, reason });
      try {
        this.options.onSessionClosed?.(reason);
      } catch {
        // Do not let a callback break auth/session fencing.
      }
    }
  }

  private assertOpenEpoch(epoch: number): void {
    if (this.closed || epoch !== this.closingEpoch) {
      throw new CuaDriverMcpProxyError("proxy_closed");
    }
  }

  private writeJson(
    response: ServerResponse,
    status: number,
    value: unknown,
    headers: Record<string, string> = {},
  ): void {
    let body: string;
    try {
      body = JSON.stringify(value);
    } catch {
      body = JSON.stringify({ error: "proxy_response_unserializable" });
      status = 500;
    }
    if (Buffer.byteLength(body, "utf8") > this.maxBodyBytes) {
      body = JSON.stringify({ error: "proxy_response_oversized" });
      status = 502;
    }
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body, "utf8"),
      "cache-control": "no-store",
      ...headers,
    });
    response.end(body);
  }

  private async closeInternal(reason: string): Promise<void> {
    this.closed = true;
    this.invalidateSession(reason);
    this.removeHostListener?.();
    this.removeHostListener = undefined;
    await this.startPromise?.catch(() => undefined);
    const hostStop = this.options.host.stop(reason).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (this.server.listening) {
      const serverClosed = new Promise<void>((resolveClose) => {
        this.server.close(() => resolveClose());
      });
      this.server.closeIdleConnections?.();
      const drainTimeoutMs = Math.min(
        boundedPositive(this.options.requestTimeoutMs, 20_000, 120_000),
        1_000,
      );
      const drained = await Promise.race([
        serverClosed.then(() => true),
        waitForTimeout(drainTimeoutMs).then(() => false),
      ]);
      if (!drained) {
        for (const socket of this.sockets) {
          socket.destroy(new CuaDriverMcpProxyError("proxy_closed"));
        }
        this.server.closeAllConnections?.();
        await serverClosed;
      }
    }
    // Drain callbacks can complete an older initialize continuation. Revoke
    // once more before close becomes externally observable.
    this.invalidateSession(reason);
    this.endpointValue = undefined;
    const hostStopResult = await hostStop;
    if (!hostStopResult.ok) {
      throw hostStopResult.error;
    }
    this.telemetry.emit("info", "cua_driver.proxy.closed", { generation: this.options.context.generation, reason });
  }
}

function readSessionId(request: IncomingMessage): string | undefined {
  const value = request.headers["mcp-session-id"];
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(value) ? value : undefined;
}

function isManagedReadinessChanged(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "method" in value && (value as { method?: unknown }).method === "ling/managed_readiness_changed";
}

function isRecord(value: unknown): value is Readonly<Record<string, any>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let timeout: NodeJS.Timeout | undefined;
  let cleanup = (): void => undefined;
  try {
    const body = new Promise<Buffer>((resolveBody, rejectBody) => {
      const onData = (chunk: Buffer | string): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > maxBytes) {
          rejectBody(new CuaDriverMcpProxyError("mcp_request_oversized"));
          request.destroy();
          return;
        }
        chunks.push(bytes);
      };
      const onEnd = (): void => resolveBody(Buffer.concat(chunks));
      const onError = (error: Error): void => rejectBody(error);
      const onAborted = (): void => rejectBody(new CuaDriverMcpProxyError("mcp_request_aborted"));
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("aborted", onAborted);
      cleanup = () => {
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("error", onError);
        request.off("aborted", onAborted);
      };
    });
    const deadline = new Promise<Buffer>((_, rejectDeadline) => {
      timeout = setTimeout(() => {
        const error = new CuaDriverMcpProxyError("mcp_request_timeout");
        request.destroy(error);
        rejectDeadline(error);
      }, timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([body, deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    cleanup();
  }
}

async function waitForTimeout(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    const timeout = setTimeout(resolveWait, milliseconds);
    timeout.unref?.();
  });
}

function boundedPositive(value: number | undefined, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, max) : fallback;
}
