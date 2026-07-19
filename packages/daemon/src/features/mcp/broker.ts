import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as SdkMcpTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpRuntimeStatusSnapshot, McpServer, McpStreamableHttpTransport, ReplaceMcpServerToolInput, SecretStatus } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker, McpBrokerOptions } from "../../context.js";
import { readLimitedResponseText } from "../../shared/http.js";
import { isRecord, readOptionalString, readString } from "../../shared/validation.js";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "./status.js";
import { createDefaultMcpProcessLauncher, type McpProcessLauncher } from "./stdio-launcher.js";
import { buildMcpHttpHeaders, createMcpTransport, McpSecretResolutionError } from "./transport-factory.js";

export function createDefaultMcpBroker(): McpBroker {
  const processLauncher = createDefaultMcpProcessLauncher();
  return {
    async checkServer(server: McpServer, options: McpBrokerOptions): Promise<{ readonly statusSnapshot: McpRuntimeStatusSnapshot }> {
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
      const timeoutMs = (server.toolTimeoutSec ?? server.startupTimeoutSec ?? 30) * 1000;
      const { result } = await withMcpClient(server, options, processLauncher, async (client) => {
        const result = await client.callTool(
          {
            name: toolName,
            arguments: isRecord(input) ? input : {},
          },
          undefined,
          { timeout: timeoutMs, signal: options.signal },
        );
        return mcpSdkCallToolResultToRunnerResult(result);
      });
      return result;
    },
  };
}

async function withMcpClient<T>(
  server: McpServer,
  options: McpBrokerOptions,
  processLauncher: McpProcessLauncher,
  callback: (client: McpClient) => Promise<T>,
): Promise<{ readonly result: T; readonly secretStatuses: readonly SecretStatus[] }> {
  const client = new McpClient({ name: "ling-stack-daemon", version: "0.1.0" });
  const resolved = createMcpTransport({
    server,
    secretResolver: options.secretResolver,
    processLauncher,
  });
  try {
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
      await client.close();
    } catch {
      // Closing a failed MCP connection is best-effort cleanup.
    }
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
