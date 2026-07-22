import { createHash, createHmac } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  DesktopCuaDriverLease,
} from "@ling-stack/contracts";
import {
  cuaDriverProxyTokenMaterialV1,
  cuaDriverWorkspaceBindingMaterialV1,
} from "@ling-stack/contracts";
import type {
  McpRuntimeStatusSnapshot,
  McpServer,
  ReplaceMcpServerToolInput,
} from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import {
  mcpSdkCallToolResultToRunnerResult,
  mcpSdkToolToStoreInput,
} from "../mcp/broker.js";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "../mcp/status.js";
import type {
  CuaDriverPooledClient,
  CuaDriverPooledClientFactory,
} from "./cua-driver-client-pool.js";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const MAX_LIST_TOOLS_PAGES = 128;
const MAX_LIST_TOOLS_COUNT = 4_096;
const BUNDLED_HEALTH_REPORT_ARGUMENTS = Object.freeze({
  skip: Object.freeze(["bundle_identity"] as const),
});
const BUNDLED_HEALTH_REQUIRED_CHECKS = Object.freeze([
  "binary_version",
  "platform_supported",
] as const);

type McpClientPort = Pick<
  McpClient,
  "callTool" | "close" | "connect" | "getServerVersion" | "listTools" | "ping"
>;

export interface CuaDriverLeaseClientCheckResult {
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}

export interface CuaDriverLeaseClientHealthResult {
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}

export interface CuaDriverLeaseClientListToolsResult {
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools: readonly ReplaceMcpServerToolInput[];
}

/**
 * One initialized SDK client bound to one exact Desktop lease generation.
 * The persisted MCP transport is deliberately never consulted by this client.
 */
export interface CuaDriverLeaseMcpClient extends CuaDriverPooledClient {
  initialize(signal?: AbortSignal): Promise<void>;
  check(server: McpServer, now: string, signal?: AbortSignal): Promise<CuaDriverLeaseClientCheckResult>;
  checkHealth(server: McpServer, now: string, signal?: AbortSignal): Promise<CuaDriverLeaseClientHealthResult>;
  listTools(server: McpServer, now: string, signal?: AbortSignal): Promise<CuaDriverLeaseClientListToolsResult>;
  callTool(
    server: McpServer,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<PiRunnerMcpToolCallResult>;
}

export interface CuaDriverLeaseMcpClientFactoryOptions {
  readonly bridgeToken: string;
  readonly initializeTimeoutMs?: number;
  readonly createClient?: () => McpClientPort;
  readonly createTransport?: (
    lease: DesktopCuaDriverLease,
    headers: Readonly<Record<string, string>>,
  ) => McpTransport;
}

export class DefaultCuaDriverLeaseMcpClientFactory
implements CuaDriverPooledClientFactory<CuaDriverLeaseMcpClient> {
  private readonly bridgeToken: string;
  private readonly initializeTimeoutMs: number;
  private readonly createClient: () => McpClientPort;
  private readonly createTransport: NonNullable<CuaDriverLeaseMcpClientFactoryOptions["createTransport"]>;

  constructor(options: CuaDriverLeaseMcpClientFactoryOptions) {
    if (!options.bridgeToken.trim()) {
      throw new Error("cua_driver_desktop_bridge_token_missing");
    }
    this.bridgeToken = options.bridgeToken;
    this.initializeTimeoutMs = boundedTimeout(options.initializeTimeoutMs);
    this.createClient = options.createClient
      ?? (() => new McpClient({ name: "ling-stack-daemon", version: "0.1.0" }));
    this.createTransport = options.createTransport
      ?? ((lease, headers) => new StreamableHTTPClientTransport(new URL(lease.endpoint), {
        requestInit: { headers },
      }));
  }

  async connect(lease: DesktopCuaDriverLease, signal: AbortSignal): Promise<CuaDriverLeaseMcpClient> {
    const client = new DefaultCuaDriverLeaseMcpClient({
      lease,
      client: this.createClient(),
      transport: this.createTransport(
        lease,
        createCuaDriverLeaseProxyHeaders(lease, this.bridgeToken),
      ),
      initializeTimeoutMs: this.initializeTimeoutMs,
    });
    try {
      await client.initialize(signal);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

class DefaultCuaDriverLeaseMcpClient implements CuaDriverLeaseMcpClient {
  private initializePromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private initialized = false;
  private closed = false;

  constructor(private readonly options: {
    readonly lease: DesktopCuaDriverLease;
    readonly client: McpClientPort;
    readonly transport: McpTransport;
    readonly initializeTimeoutMs: number;
  }) {}

  initialize(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("cua_driver_lease_client_closed"));
    }
    if (this.initialized) {
      return Promise.resolve();
    }
    if (this.initializePromise) {
      return this.initializePromise;
    }
    const pending = this.options.client.connect(this.options.transport, {
      timeout: this.options.initializeTimeoutMs,
      signal,
    }).then(() => {
      if (this.closed) {
        throw new Error("cua_driver_lease_client_closed");
      }
      validateInitializeServerInfo(
        this.options.client.getServerVersion(),
        this.options.lease,
      );
      this.initialized = true;
    });
    this.initializePromise = pending;
    void pending.finally(() => {
      if (this.initializePromise === pending) {
        this.initializePromise = undefined;
      }
    }).catch(() => undefined);
    return pending;
  }

  async check(
    server: McpServer,
    now: string,
    signal?: AbortSignal,
  ): Promise<CuaDriverLeaseClientCheckResult> {
    this.assertUsable();
    const startedAt = Date.now();
    const timeout = operationTimeout(server.startupTimeoutSec);
    try {
      await this.options.client.ping({ timeout, signal });
      const serverInfo = this.options.client.getServerVersion();
      return {
        statusSnapshot: createMcpStatusSnapshot({
          server,
          now,
          status: "ready",
          authStatus: createMcpAuthStatus([]),
          serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
          latencyMs: Date.now() - startedAt,
          message: serverInfo?.name
            ? `Connected to ${serverInfo.name}.`
            : "Connected to bundled Cua Driver MCP proxy.",
        }),
      };
    } catch (error) {
      return {
        statusSnapshot: failedStatus(
          server,
          now,
          error,
          Date.now() - startedAt,
          "cua_driver_check_failed",
        ),
      };
    }
  }

  async listTools(
    server: McpServer,
    now: string,
    signal?: AbortSignal,
  ): Promise<CuaDriverLeaseClientListToolsResult> {
    this.assertUsable();
    const startedAt = Date.now();
    const timeout = operationTimeout(server.toolTimeoutSec ?? server.startupTimeoutSec);
    const deadlineAt = startedAt + timeout;
    const deadlineSignal = AbortSignal.timeout(timeout);
    const operationSignal = signal
      ? AbortSignal.any([signal, deadlineSignal])
      : deadlineSignal;
    try {
      const tools: ReplaceMcpServerToolInput[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        operationSignal.throwIfAborted();
        pages += 1;
        if (pages > MAX_LIST_TOOLS_PAGES) {
          throw new Error("cua_driver_tool_page_limit_exceeded");
        }
        const remainingTimeout = Math.max(1, deadlineAt - Date.now());
        const page = await this.options.client.listTools(
          cursor ? { cursor } : undefined,
          { timeout: remainingTimeout, signal: operationSignal },
        );
        if (tools.length + page.tools.length > MAX_LIST_TOOLS_COUNT) {
          throw new Error("cua_driver_tool_count_limit_exceeded");
        }
        tools.push(...page.tools.map((tool) => mcpSdkToolToStoreInput(server, tool)));
        cursor = page.nextCursor;
        if (cursor) {
          if (seenCursors.has(cursor)) {
            throw new Error("cua_driver_tool_cursor_repeated");
          }
          seenCursors.add(cursor);
        }
      } while (cursor);
      return {
        statusSnapshot: createMcpStatusSnapshot({
          server,
          now,
          status: "ready",
          authStatus: createMcpAuthStatus([]),
          toolCount: tools.length,
          latencyMs: Date.now() - startedAt,
          message: `${tools.length} MCP tool(s) discovered.`,
        }),
        tools,
      };
    } catch (error) {
      return {
        statusSnapshot: failedStatus(
          server,
          now,
          error,
          Date.now() - startedAt,
          "cua_driver_tool_sync_failed",
        ),
        tools: [],
      };
    }
  }

  async checkHealth(
    server: McpServer,
    now: string,
    signal?: AbortSignal,
  ): Promise<CuaDriverLeaseClientHealthResult> {
    this.assertUsable();
    const startedAt = Date.now();
    const timeout = operationTimeout(server.toolTimeoutSec ?? server.startupTimeoutSec);
    try {
      const result = await this.options.client.callTool(
        {
          name: "health_report",
          arguments: BUNDLED_HEALTH_REPORT_ARGUMENTS,
        },
        undefined,
        { timeout, signal },
      );
      validateBundledHealthReport(result, this.options.lease);
      return {
        statusSnapshot: createMcpStatusSnapshot({
          server,
          now,
          status: "ready",
          authStatus: createMcpAuthStatus([]),
          latencyMs: Date.now() - startedAt,
          message: "Bundled Cua Driver health_report passed.",
        }),
      };
    } catch (error) {
      const failureKind = error instanceof CuaDriverLeaseHealthError
        ? error.failureKind
        : "failed";
      return {
        statusSnapshot: healthFailedStatus(
          server,
          now,
          failureKind,
          Date.now() - startedAt,
        ),
      };
    }
  }

  async callTool(
    server: McpServer,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<PiRunnerMcpToolCallResult> {
    this.assertUsable();
    const result = await this.options.client.callTool(
      {
        name: toolName,
        arguments: isRecord(input) ? input : {},
      },
      undefined,
      {
        timeout: operationTimeout(server.toolTimeoutSec ?? server.startupTimeoutSec),
        signal,
      },
    );
    return mcpSdkCallToolResultToRunnerResult(result);
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.initialized = false;
    const pending = Promise.resolve(this.options.client.close()).then(() => undefined);
    this.closePromise = pending;
    return pending;
  }

  private assertUsable(): void {
    if (this.closed || !this.initialized) {
      throw new Error(this.closed
        ? "cua_driver_lease_client_closed"
        : "cua_driver_lease_client_not_initialized");
    }
  }
}

/** Headers required by Desktop's one-generation MCP proxy. */
export function createCuaDriverLeaseProxyHeaders(
  lease: DesktopCuaDriverLease,
  bridgeToken: string,
): Readonly<Record<string, string>> {
  if (!bridgeToken.trim()) {
    throw new Error("cua_driver_desktop_bridge_token_missing");
  }
  return Object.freeze({
    Authorization: `Bearer ${deriveCuaDriverLeaseProxyToken(lease, bridgeToken)}`,
    "x-ling-cua-driver-generation": String(lease.generation),
    "x-ling-cua-driver-workspace-sha256": createHash("sha256")
      .update(cuaDriverWorkspaceBindingMaterialV1(lease.workspaceCwd), "utf8")
      .digest("base64url"),
    "x-ling-cua-driver-authority-epoch": lease.daemonAuthorityEpoch,
    "x-ling-cua-driver-instance-epoch": String(lease.desktopInstanceEpoch),
    "x-ling-cua-driver-bridge-connection": lease.bridgeConnectionId,
  });
}

export function deriveCuaDriverLeaseProxyToken(
  lease: DesktopCuaDriverLease,
  bridgeToken: string,
): string {
  return createHmac("sha256", bridgeToken)
    .update(cuaDriverProxyTokenMaterialV1(lease), "utf8")
    .digest("base64url");
}

function failedStatus(
  server: McpServer,
  now: string,
  error: unknown,
  latencyMs: number,
  errorCode = "cua_desktop_lease_client_failed",
): McpRuntimeStatusSnapshot {
  return createMcpStatusSnapshot({
    server,
    now,
    status: "failed",
    authStatus: createMcpAuthStatus([]),
    errorCode,
    latencyMs,
    message: error instanceof Error ? error.message : String(error),
  });
}

function validateInitializeServerInfo(
  serverInfo: ReturnType<McpClientPort["getServerVersion"]>,
  lease: DesktopCuaDriverLease,
): void {
  if (!serverInfo || serverInfo.name !== lease.providerId) {
    throw new Error("cua_embedded_protocol_mismatch");
  }
  if (serverInfo.version !== lease.providerVersion) {
    throw new Error("cua_bundled_version_mismatch");
  }
}

type CuaDriverLeaseHealthFailureKind = "failed" | "incompatible";

class CuaDriverLeaseHealthError extends Error {
  constructor(readonly failureKind: CuaDriverLeaseHealthFailureKind) {
    super(`cua_driver_health_report_${failureKind}`);
    this.name = "CuaDriverLeaseHealthError";
  }
}

function validateBundledHealthReport(
  result: unknown,
  lease: DesktopCuaDriverLease,
): void {
  if (!isRecord(result)) {
    throw new CuaDriverLeaseHealthError("incompatible");
  }
  if (("isError" in result && typeof result.isError !== "boolean") || result.isError === true) {
    throw new CuaDriverLeaseHealthError(
      result.isError === true ? "failed" : "incompatible",
    );
  }
  const report = result.structuredContent;
  if (!isRecord(report)
    || (report.schema_version !== 1 && report.schema_version !== "1")
    || report.driver_version !== lease.providerVersion
    || report.platform !== lease.platform
    || report.overall !== "ok"
    || !Array.isArray(report.checks)) {
    throw new CuaDriverLeaseHealthError("incompatible");
  }

  const checks = new Map<string, string>();
  for (const value of report.checks) {
    if (!isRecord(value)
      || typeof value.name !== "string"
      || typeof value.status !== "string"
      || checks.has(value.name)) {
      throw new CuaDriverLeaseHealthError("incompatible");
    }
    checks.set(value.name, value.status);
  }
  if (BUNDLED_HEALTH_REQUIRED_CHECKS.some((name) => checks.get(name) !== "pass")
    || checks.get("bundle_identity") !== "skip") {
    throw new CuaDriverLeaseHealthError("incompatible");
  }
}

function healthFailedStatus(
  server: McpServer,
  now: string,
  failureKind: CuaDriverLeaseHealthFailureKind,
  latencyMs: number,
): McpRuntimeStatusSnapshot {
  return createMcpStatusSnapshot({
    server,
    now,
    status: "failed",
    authStatus: createMcpAuthStatus([]),
    errorCode: failureKind === "incompatible"
      ? "cua_driver_health_report_incompatible"
      : "cua_driver_health_report_failed",
    latencyMs,
    message: failureKind === "incompatible"
      ? "Bundled Cua Driver returned an incompatible structured health_report."
      : "Bundled Cua Driver health_report failed.",
  });
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new Error("cua_driver_lease_client_timeout_invalid");
  }
  return timeout;
}

function operationTimeout(seconds: number | undefined): number {
  const value = seconds ?? 30;
  return Math.max(1, Math.min(value, 120)) * 1_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
