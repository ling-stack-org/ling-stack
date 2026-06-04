import { randomUUID } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as SdkMcpTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer, McpServerStatus, McpStreamableHttpTransport, ReplaceMcpServerToolInput } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker } from "../../context.js";
import { readLimitedResponseText } from "../../shared/http.js";
import { isRecord, readOptionalString, readString } from "../../shared/validation.js";

export function createDefaultMcpBroker(): McpBroker {
  return {
    async checkServer(server: McpServer, secrets: Readonly<Record<string, string>>): Promise<{ readonly status: McpServerStatus }> {
      if (!server.enabled) {
        return {
          status: {
            kind: "disabled",
            message: "MCP server is disabled.",
            checkedAt: new Date().toISOString(),
          },
        };
      }
      const timeoutMs = (server.startupTimeoutSec ?? 30) * 1000;
      const serverName = await withMcpClient(server, secrets, async (client) => {
        await client.ping({ timeout: timeoutMs });
        return client.getServerVersion()?.name;
      });
      return {
        status: {
          kind: "ready",
          message: serverName ? `Connected to ${serverName}.` : `Connected to MCP ${server.transport.type} server.`,
          checkedAt: new Date().toISOString(),
        },
      };
    },
    async listTools(server: McpServer, secrets: Readonly<Record<string, string>>): Promise<readonly ReplaceMcpServerToolInput[]> {
      const timeoutMs = (server.toolTimeoutSec ?? server.startupTimeoutSec ?? 30) * 1000;
      try {
        return await withMcpClient(server, secrets, async (client) => {
          const tools: ReplaceMcpServerToolInput[] = [];
          let cursor: string | undefined;
          do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
            tools.push(...page.tools.map((tool) => mcpSdkToolToStoreInput(server, tool)));
            cursor = page.nextCursor;
          } while (cursor);
          return tools;
        });
      } catch (error) {
        if (server.transport.type !== "streamable-http") {
          throw error;
        }
        const httpServer = server as McpServer & { readonly transport: McpStreamableHttpTransport };
        return rawListMcpToolsOverHttp(httpServer, secrets, timeoutMs);
      }
    },
    async callTool(
      server: McpServer,
      secrets: Readonly<Record<string, string>>,
      toolName: string,
      input: unknown,
    ): Promise<PiRunnerMcpToolCallResult> {
      const timeoutMs = (server.toolTimeoutSec ?? server.startupTimeoutSec ?? 30) * 1000;
      return withMcpClient(server, secrets, async (client) => {
        const result = await client.callTool(
          {
            name: toolName,
            arguments: isRecord(input) ? input : {},
          },
          undefined,
          { timeout: timeoutMs },
        );
        return mcpSdkCallToolResultToRunnerResult(result);
      });
    },
  };
}

async function withMcpClient<T>(
  server: McpServer,
  secrets: Readonly<Record<string, string>>,
  callback: (client: McpClient) => Promise<T>,
): Promise<T> {
  const client = new McpClient({ name: "ling-stack-daemon", version: "0.1.0" });
  const transport = createMcpTransport(server, secrets);
  try {
    await client.connect(transport, { timeout: (server.startupTimeoutSec ?? 30) * 1000 });
    return await callback(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Closing a failed MCP connection is best-effort cleanup.
    }
  }
}

function createMcpTransport(server: McpServer, secrets: Readonly<Record<string, string>>): McpTransport {
  if (server.transport.type === "stdio") {
    const env = {
      ...getDefaultEnvironment(),
      ...server.transport.env,
    };
    for (const secretName of server.transport.secretEnvNames) {
      const value = secrets[secretName];
      if (value !== undefined) {
        env[secretName] = value;
      }
    }
    return new StdioClientTransport({
      command: server.transport.command,
      args: [...server.transport.args],
      env,
      cwd: server.transport.cwd,
      stderr: "pipe",
    });
  }

  const httpServer = server as McpServer & { readonly transport: McpStreamableHttpTransport };
  const headers = buildMcpHttpHeaders(httpServer, secrets);
  return new StreamableHTTPClientTransport(new URL(httpServer.transport.url), {
    requestInit: { headers },
  });
}

function buildMcpHttpHeaders(server: McpServer & { readonly transport: McpStreamableHttpTransport }, secrets: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = { ...server.transport.headers };
  for (const [headerName, envName] of Object.entries(server.transport.envHeaders)) {
    const value = process.env[envName];
    if (value !== undefined) {
      headers[headerName] = value;
    }
  }
  if (server.transport.bearerTokenEnvVar) {
    const value = process.env[server.transport.bearerTokenEnvVar];
    if (value !== undefined && headers.Authorization === undefined) {
      headers.Authorization = `Bearer ${value}`;
    }
  }
  for (const secretName of server.transport.secretHeaderNames) {
    const value = secrets[secretName];
    if (value !== undefined) {
      headers[secretName] = value;
    }
  }
  return headers;
}

async function rawListMcpToolsOverHttp(
  server: McpServer & { readonly transport: McpStreamableHttpTransport },
  secrets: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<readonly ReplaceMcpServerToolInput[]> {
  const tools: ReplaceMcpServerToolInput[] = [];
  let cursor: string | undefined;
  do {
    const response = await fetch(server.transport.url, {
      method: "POST",
      headers: {
        ...buildMcpHttpHeaders(server, secrets),
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
  return tools;
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

function mcpSdkToolToStoreInput(server: McpServer, tool: SdkMcpTool): ReplaceMcpServerToolInput {
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

function mcpSdkCallToolResultToRunnerResult(result: Awaited<ReturnType<McpClient["callTool"]>>): PiRunnerMcpToolCallResult {
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
