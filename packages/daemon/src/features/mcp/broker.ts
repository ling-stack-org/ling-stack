import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as SdkMcpTool } from "@modelcontextprotocol/sdk/types.js";
import { CHROME_BROWSER_MCP_SERVER_ID, OFFICE_DOCUMENTS_MCP_SERVER_ID } from "@ling-stack/contracts";
import type { McpRuntimeStatusSnapshot, McpServer, McpStreamableHttpTransport, ReplaceMcpServerToolInput, SecretStatus } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker, McpBrokerOptions } from "../../context.js";
import { readLimitedResponseText } from "../../shared/http.js";
import { isRecord, readOptionalString, readString } from "../../shared/validation.js";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "./status.js";
import { createDefaultMcpProcessLauncher, type McpProcessLauncher } from "./stdio-launcher.js";
import { buildMcpHttpHeaders, createMcpTransport, McpSecretResolutionError } from "./transport-factory.js";
import { assertHostMcpOperation, McpHostAdmissionError } from "./host-operation.js";
import { CUA_DRIVER_MCP_SERVER_ID } from "../plugins/presets.js";
import { assertHostOfficeLocalMcpAdmission, executeHostOfficeLocalMcpOperation,
  isOfficeLocalArtifactToolName } from "./office-local-mcp-operation.js";

// Host-owned capability. A copied/custom/generation broker or a replaced method
// cannot assert its own support through McpBrokerOptions or public booleans.
type GenerationRoute = { readonly kind: "chrome" | "office" } | { readonly kind: "cua"; readonly bundledEnabled: boolean };
type BrokerAdmission = { readonly callTool: McpBroker["callTool"] } & (
  | { readonly kind: "default_transport" }
  | { readonly kind: "generation_facade"; readonly baseBroker: McpBroker; readonly route: GenerationRoute }
  | { readonly kind: "office_local_facade"; readonly baseBroker: McpBroker; readonly workspaceCwd: string }
);
const hostAdmissionBrokers = new WeakMap<McpBroker, BrokerAdmission>();

/** Registry validation must not execute an accessor that can change between reads. */
function ownCallToolMethod(broker: McpBroker): McpBroker["callTool"] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(broker, "callTool");
  return descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
    ? descriptor.value as McpBroker["callTool"] : undefined;
}

/** Capture only the exact registered own data method, never a separately fetched caller callback. */
export function captureRegisteredMcpBrokerCallTool(broker: McpBroker): McpBroker["callTool"] {
  const registered = hostAdmissionBrokers.get(broker), method = ownCallToolMethod(broker);
  if (!registered || !method || registered.callTool !== method) {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "The original registered Host broker method is required.");
  }
  return method;
}

export function assertMcpBrokerHostAdmission(broker: McpBroker, server: McpServer): void {
  let current = broker;
  for (let depth = 0; depth < 16; depth++) {
    const registered = hostAdmissionBrokers.get(current);
    if (!registered || registered.callTool !== ownCallToolMethod(current)) break;
    if (registered.kind === "default_transport") {
      if (server.transport.type === "streamable-http" || server.transport.type === "stdio") return;
      break;
    }
    if (registered.kind === "office_local_facade" ? server.id === OFFICE_DOCUMENTS_MCP_SERVER_ID
      : ownsGenerationServer(registered.route, server.id)) break;
    current = registered.baseBroker;
  }
  throw new McpHostAdmissionError("mcp_host_admission_unsupported",
    "Captured Host admission requires a registered native transport delegation chain; custom/owned generation dispatch is unsupported.");
}

/** Original factory identity across a complete registered chain; names/clones cannot register support. */
export function findHostOfficeLocalFactory(broker: McpBroker, serverId: string, toolName: string,
  workspaceCwd?: string): McpBroker | undefined {
  if (serverId !== OFFICE_DOCUMENTS_MCP_SERVER_ID || !isOfficeLocalArtifactToolName(toolName)) return undefined;
  let current = broker, factory: McpBroker | undefined;
  for (let depth = 0; depth < 16; depth++) {
    const registered = hostAdmissionBrokers.get(current);
    if (!registered || registered.callTool !== ownCallToolMethod(current)) return undefined;
    if (registered.kind === "default_transport") return factory;
    if (registered.kind === "office_local_facade") {
      if (factory || (workspaceCwd !== undefined && workspaceCwd !== registered.workspaceCwd)) return undefined;
      factory = current;
    } else if (!factory && ownsGenerationServer(registered.route, serverId)) return undefined;
    current = registered.baseBroker;
  }
  return undefined;
}

/**
 * Construct the tracked dispatch seam, not a registration API for caller claims.
 * A generation's untracked behavior is preserved. A tracked generic route calls
 * only the registered base; arbitrary generation callbacks cannot run or mint
 * permission by claiming that they consume a guard. Fixed selectors match the
 * three existing Host factories and never grant their owned execution support.
 */
export function createHostMcpGenerationFacade(input: {
  readonly baseBroker: McpBroker;
  readonly route: GenerationRoute;
  readonly facade: McpBroker;
}): McpBroker {
  return createGenerationFacade(input, false);
}

/** Fixed Office factory: tracked owned execution never invokes the supplied facade callback. */
export function createHostOfficeLocalGenerationFacade(input: {
  readonly baseBroker: McpBroker;
  readonly workspaceCwd: string;
  readonly facade: McpBroker;
}): McpBroker {
  return createGenerationFacade({ ...input, route: { kind: "office" } }, true, input.workspaceCwd);
}

function createGenerationFacade(input: {
  readonly baseBroker: McpBroker;
  readonly route: GenerationRoute;
  readonly facade: McpBroker;
}, officeLocal: boolean, workspaceCwd?: string): McpBroker {
  const baseBroker = input.baseBroker;
  const route = Object.freeze({ ...input.route });
  const facade = input.facade;
  const broker: McpBroker = {
    ...facade,
    async checkServer(server, options) {
      assertUntrackedMetadataCall(options);
      return facade.checkServer(server, options);
    },
    async listTools(server, options) {
      assertUntrackedMetadataCall(options);
      return facade.listTools(server, options);
    },
    async callTool(server, options, toolName, toolInput) {
      assertExclusiveHostOperations(options);
      if (options.officeLocalOperation) {
        assertHostOfficeLocalMcpAdmission(options.officeLocalOperation, broker, server.id, toolName);
        if (officeLocal && server.id === OFFICE_DOCUMENTS_MCP_SERVER_ID) {
          if (workspaceCwd !== options.workspaceCwd) throw new McpHostAdmissionError("mcp_host_admission_unsupported", "Office factory workspace does not match its original scope.");
          return executeHostOfficeLocalMcpOperation(options.officeLocalOperation, broker, options, toolName, toolInput);
        }
        return Reflect.apply(captureRegisteredMcpBrokerCallTool(baseBroker), baseBroker, [server, options, toolName, toolInput]);
      }
      if (!options.hostOperation) return facade.callTool(server, options, toolName, toolInput);
      assertHostMcpOperation(options.hostOperation);
      assertMcpBrokerHostAdmission(broker, server);
      // Each current generic branch delegates directly to its base as well.
      // Owned routes reject above, before leases, artifact/desktop effects.
      return Reflect.apply(captureRegisteredMcpBrokerCallTool(baseBroker), baseBroker, [server, options, toolName, toolInput]);
    },
  };
  hostAdmissionBrokers.set(broker, officeLocal
    ? Object.freeze({ kind: "office_local_facade", callTool: broker.callTool, baseBroker, workspaceCwd: workspaceCwd! })
    : Object.freeze({ kind: "generation_facade", callTool: broker.callTool, baseBroker, route }));
  return broker;
}

function ownsGenerationServer(route: GenerationRoute, serverId: string): boolean {
  if (route.kind === "chrome") return serverId === CHROME_BROWSER_MCP_SERVER_ID;
  if (route.kind === "office") return serverId === OFFICE_DOCUMENTS_MCP_SERVER_ID;
  return route.kind === "cua" && route.bundledEnabled && serverId === CUA_DRIVER_MCP_SERVER_ID;
}

export function createDefaultMcpBroker(): McpBroker {
  const processLauncher = createDefaultMcpProcessLauncher();
  const broker: McpBroker = {
    async checkServer(server: McpServer, options: McpBrokerOptions): Promise<{ readonly statusSnapshot: McpRuntimeStatusSnapshot }> {
      assertUntrackedMetadataCall(options);
      const now = currentMcpNow(options);
      if (!server.enabled) {
        return {
          statusSnapshot: createMcpStatusSnapshot({
            server,
            now,
            status: "disabled",
            authStatus: createMcpAuthStatus([]),
            message: "MCP server is disabled.",
          }),
        };
      }
      const timeoutMs = (server.startupTimeoutSec ?? 30) * 1000;
      const startedAt = Date.now();
      try {
        const { result, secretStatuses } = await withMcpClient(server, options, processLauncher, async (client) => {
          await client.ping({ timeout: timeoutMs });
          return client.getServerVersion();
        });
        const serverName = result?.name;
        return {
          statusSnapshot: createMcpStatusSnapshot({
            server,
            now,
            status: "ready",
            authStatus: createMcpAuthStatus(secretStatuses),
            serverInfo: result ? { name: result.name, version: result.version } : undefined,
            latencyMs: Date.now() - startedAt,
            message: serverName ? `Connected to ${serverName}.` : `Connected to MCP ${server.transport.type} server.`,
          }),
        };
      } catch (error) {
        return {
          statusSnapshot: failedSnapshotFromError(server, now, error, Date.now() - startedAt),
        };
      }
    },
    async listTools(server: McpServer, options: McpBrokerOptions): Promise<{
      readonly statusSnapshot: McpRuntimeStatusSnapshot;
      readonly tools: readonly ReplaceMcpServerToolInput[];
    }> {
      assertUntrackedMetadataCall(options);
      const now = currentMcpNow(options);
      if (!server.enabled) {
        return {
          statusSnapshot: createMcpStatusSnapshot({
            server,
            now,
            status: "disabled",
            authStatus: createMcpAuthStatus([]),
            message: "MCP server is disabled.",
          }),
          tools: [],
        };
      }
      const timeoutMs = (server.toolTimeoutSec ?? server.startupTimeoutSec ?? 30) * 1000;
      const startedAt = Date.now();
      try {
        const { result, secretStatuses } = await withMcpClient(server, options, processLauncher, async (client) => {
          const tools: ReplaceMcpServerToolInput[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
            tools.push(...page.tools.map((tool) => mcpSdkToolToStoreInput(server, tool)));
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        });
        return {
          statusSnapshot: createMcpStatusSnapshot({
            server,
            now,
            status: "ready",
            authStatus: createMcpAuthStatus(secretStatuses),
            toolCount: result.length,
            latencyMs: Date.now() - startedAt,
            message: `${result.length} MCP tool(s) discovered.`,
          }),
          tools: result,
        };
      } catch (error) {
        if (server.transport.type !== "streamable-http") {
          return {
            statusSnapshot: failedSnapshotFromError(server, now, error, Date.now() - startedAt),
            tools: [],
          };
        }
        try {
          const httpServer = server as McpServer & { readonly transport: McpStreamableHttpTransport };
          const { tools, secretStatuses } = await rawListMcpToolsOverHttp(httpServer, options, timeoutMs);
          return {
            statusSnapshot: createMcpStatusSnapshot({
              server,
              now,
              status: "ready",
              authStatus: createMcpAuthStatus(secretStatuses),
              toolCount: tools.length,
              latencyMs: Date.now() - startedAt,
              message: `${tools.length} MCP tool(s) discovered.`,
            }),
            tools,
          };
        } catch (fallbackError) {
          return {
            statusSnapshot: failedSnapshotFromError(server, now, fallbackError, Date.now() - startedAt),
            tools: [],
          };
        }
      }
    },
    async callTool(
      server: McpServer,
      options: McpBrokerOptions,
      toolName: string,
      input: unknown,
    ): Promise<PiRunnerMcpToolCallResult> {
      assertExclusiveHostOperations(options);
      if (options.officeLocalOperation) throw new McpHostAdmissionError("mcp_host_admission_unsupported", "A fixed Office scope cannot authorize a generic MCP transport.");
      if (options.hostOperation) {
        assertHostMcpOperation(options.hostOperation);
        assertMcpBrokerHostAdmission(broker, server);
      }
      const timeoutMs = (server.toolTimeoutSec ?? server.startupTimeoutSec ?? 30) * 1000;
      const { result } = await withMcpClient(server, options, processLauncher, async (client) => {
        let pending: ReturnType<McpClient["callTool"]> | undefined;
        const dispatch = (): void => {
          pending = client.callTool(
            { name: toolName, arguments: isRecord(input) ? input : {} },
            undefined,
            { timeout: timeoutMs, signal: options.signal },
          );
        };
        // Recheck after connect. The transport then independently gates every
        // actual HTTP fetch after SDK awaits, retries and reconnect timers.
        try {
          if (options.hostOperation) options.hostOperation.launchToolDispatch(dispatch);
          else dispatch();
        } catch (error) {
          // A launch/COMMIT failure may occur after SDK request creation. The
          // public close immediately seals the transport's queued native sends,
          // before an async callback rejection reaches withMcpClient's finally.
          // Otherwise the send microtask could perform I/O after parent COMMIT
          // failed. Finally still awaits this same original bounded close.
          if (pending) void pending.catch(() => {});
          void client.close().catch(() => {});
          throw error;
        }
        const result = await pending!;
        return mcpSdkCallToolResultToRunnerResult(result);
      });
      options.signal?.throwIfAborted();
      options.assertResultCurrent?.();
      return result;
    },
  };
  hostAdmissionBrokers.set(broker, Object.freeze({ kind: "default_transport", callTool: broker.callTool }));
  return broker;
}

async function withMcpClient<T>(
  server: McpServer,
  options: McpBrokerOptions,
  processLauncher: McpProcessLauncher,
  callback: (client: McpClient) => Promise<T>,
): Promise<{ readonly result: T; readonly secretStatuses: readonly SecretStatus[] }> {
  if (options.hostOperation) {
    assertHostMcpOperation(options.hostOperation);
    options.hostOperation.assertMayPrepare();
  }
  const client = new McpClient({ name: "ling-stack-daemon", version: "0.1.0" });
  const resolved = createMcpTransport({
    server,
    secretResolver: options.secretResolver,
    processLauncher,
    hostOperation: options.hostOperation,
    signal: options.signal,
  });
  try {
    options.hostOperation?.assertMayPrepare();
    await client.connect(resolved.transport, {
      timeout: (server.startupTimeoutSec ?? 30) * 1000,
      signal: options.signal,
    });
    return {
      result: await callback(client),
      secretStatuses: resolved.secretStatuses,
    };
  } finally {
    try {
      // HTTP cancels only local I/O. The native stdio adapter independently
      // fences each original-process cleanup and awaits bounded local closure.
      // Neither close path proves remote/descendant whole-operation safety.
      await client.close();
    } catch {
      // Entered Host scopes still finish as unknown even when local cleanup fails.
    }
  }
}

function assertUntrackedMetadataCall(options: McpBrokerOptions): void {
  if (options.hostOperation || options.officeLocalOperation) {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "A tool-call capability cannot authorize an unrelated MCP metadata operation.");
  }
}

function assertExclusiveHostOperations(options: McpBrokerOptions): void {
  if (options.hostOperation && options.officeLocalOperation) {
    throw new McpHostAdmissionError("mcp_host_admission_unsupported", "MCP transport and fixed Office capabilities are mutually exclusive.");
  }
}

async function rawListMcpToolsOverHttp(
  server: McpServer & { readonly transport: McpStreamableHttpTransport },
  options: McpBrokerOptions,
  timeoutMs: number,
): Promise<{ readonly tools: readonly ReplaceMcpServerToolInput[]; readonly secretStatuses: readonly SecretStatus[] }> {
  const tools: ReplaceMcpServerToolInput[] = [];
  const { headers, statuses } = buildMcpHttpHeaders({
    transport: server.transport,
    secretResolver: options.secretResolver,
  });
  let cursor: string | undefined;
  do {
    const response = await fetch(server.transport.url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const bodyText = await readLimitedResponseText(response, 1024 * 1024);
    if (!response.ok) {
      throw new Error(`MCP tools/list failed with HTTP ${response.status}: ${bodyText}`);
    }
    const payload = parseMcpJsonRpcHttpPayload(bodyText);
    if (!isRecord(payload)) {
      throw new Error("MCP tools/list response must be a JSON-RPC object.");
    }
    if (isRecord(payload.error)) {
      throw new Error(`MCP tools/list failed: ${readOptionalString(payload.error, "message") ?? JSON.stringify(payload.error)}`);
    }
    if (!isRecord(payload.result)) {
      throw new Error("MCP tools/list response is missing result.");
    }
    const rawTools = payload.result.tools;
    if (!Array.isArray(rawTools)) {
      throw new Error("MCP tools/list result.tools must be an array.");
    }
    tools.push(...rawTools.map((tool) => rawMcpToolToStoreInput(server, tool)));
    cursor = readOptionalString(payload.result, "nextCursor");
  } while (cursor);
  return { tools, secretStatuses: statuses };
}

function currentMcpNow(options: McpBrokerOptions): string {
  return options.now ? options.now() : new Date().toISOString();
}

function failedSnapshotFromError(server: McpServer, now: string, error: unknown, latencyMs?: number): McpRuntimeStatusSnapshot {
  if (error instanceof McpSecretResolutionError) {
    return createMcpStatusSnapshot({
      server,
      now,
      status: "failed",
      authStatus: createMcpAuthStatus(error.statuses),
      latencyMs,
      errorCode: "mcp_secret_missing",
      message: error.message,
    });
  }
  return createMcpStatusSnapshot({
    server,
    now,
    status: "failed",
    authStatus: createMcpAuthStatus([]),
    latencyMs,
    errorCode: "mcp_connection_failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

function parseMcpJsonRpcHttpPayload(bodyText: string): unknown {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    throw new Error("MCP HTTP response did not contain JSON data.");
  }
  return JSON.parse(dataLines[dataLines.length - 1] ?? "");
}

function rawMcpToolToStoreInput(server: McpServer, value: unknown): ReplaceMcpServerToolInput {
  if (!isRecord(value)) {
    throw new Error("MCP tool entry must be an object.");
  }
  const rawName = readString(value, "name");
  const annotations = isRecord(value.annotations) ? value.annotations : undefined;
  const sideEffectLevel = inferRawMcpToolSideEffectLevel(annotations);
  return {
    rawName,
    displayName: readOptionalString(value, "title") ?? (annotations ? readOptionalString(annotations, "title") : undefined) ?? rawName,
    description: readOptionalString(value, "description"),
    inputSchema: value.inputSchema ?? { type: "object", additionalProperties: true },
    callableNamespace: server.id,
    callableName: rawName,
    sideEffectLevel,
    defaultApproval: sideEffectLevel === "read" ? "allow" : "ask",
    enabled: true,
  };
}

function inferRawMcpToolSideEffectLevel(annotations: Record<string, unknown> | undefined): ReplaceMcpServerToolInput["sideEffectLevel"] {
  if (annotations?.readOnlyHint === true && annotations.destructiveHint !== true) {
    return "read";
  }
  if (annotations?.destructiveHint === true) {
    return annotations.openWorldHint === true ? "external" : "write";
  }
  if (annotations?.openWorldHint === true) {
    return "external";
  }
  return "external";
}

export function mcpSdkToolToStoreInput(server: McpServer, tool: SdkMcpTool): ReplaceMcpServerToolInput {
  const sideEffectLevel = inferMcpToolSideEffectLevel(tool);
  return {
    rawName: tool.name,
    displayName: tool.title ?? tool.annotations?.title ?? tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    callableNamespace: server.id,
    callableName: tool.name,
    sideEffectLevel,
    defaultApproval: sideEffectLevel === "read" ? "allow" : "ask",
    enabled: true,
  };
}

function inferMcpToolSideEffectLevel(tool: SdkMcpTool): ReplaceMcpServerToolInput["sideEffectLevel"] {
  if (tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true) {
    return "read";
  }
  if (tool.annotations?.destructiveHint === true) {
    return tool.annotations.openWorldHint === true ? "external" : "write";
  }
  if (tool.annotations?.openWorldHint === true) {
    return "external";
  }
  return "external";
}

export function mcpSdkCallToolResultToRunnerResult(result: Awaited<ReturnType<McpClient["callTool"]>>): PiRunnerMcpToolCallResult {
  if ("toolResult" in result) {
    return {
      content: [{ type: "text", text: formatUnknownForToolText(result.toolResult) }],
      details: result,
    };
  }
  return {
    content: result.content.flatMap((item) => mcpSdkContentToRunnerContent(item as McpSdkContentLike)),
    details: {
      structuredContent: result.structuredContent,
      meta: result._meta,
    },
    isError: result.isError,
  };
}

type McpSdkContentLike = Readonly<Record<string, unknown>> & {
  readonly type?: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: unknown;
  readonly uri?: string;
  readonly name?: string;
  readonly title?: string;
};

function mcpSdkContentToRunnerContent(item: McpSdkContentLike): PiRunnerMcpToolCallResult["content"][number][] {
  if (item.type === "text") {
    return [{ type: "text", text: item.text ?? "" }];
  }
  if (item.type === "image") {
    return [{ type: "image", data: item.data ?? "", mimeType: item.mimeType ?? "image/png" }];
  }
  if (item.type === "resource") {
    if (isRecord(item.resource) && typeof item.resource.text === "string") {
      return [{ type: "text", text: item.resource.text }];
    }
    const uri = isRecord(item.resource) && typeof item.resource.uri === "string" ? item.resource.uri : "resource";
    const mimeType = isRecord(item.resource) && typeof item.resource.mimeType === "string" ? item.resource.mimeType : "binary content";
    return [{ type: "text", text: `Resource ${uri} returned ${mimeType}.` }];
  }
  if (item.type === "resource_link") {
    return [{ type: "text", text: item.title ?? item.name ?? item.uri ?? "resource link" }];
  }
  if (item.type === "audio") {
    return [{ type: "text", text: `Audio output (${item.mimeType ?? "unknown"}) is not rendered in this runner.` }];
  }
  return [{ type: "text", text: formatUnknownForToolText(item) }];
}

function formatUnknownForToolText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
