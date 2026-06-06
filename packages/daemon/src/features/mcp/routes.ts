import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { McpBroker } from "../../context.js";
import type { SecretResolver } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { parseMcpServerCreateRequest, parseMcpServerUpdateRequest } from "./schemas.js";
import { toPublicMcpServer } from "./secrets.js";

export async function handleMcpServersCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        servers: store.listMcpServers({
          enabled: readOptionalBooleanQuery(url, "enabled"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }).map((server) => toPublicMcpServer({ store, server, secretResolver, now: new Date().toISOString() })),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseMcpServerCreateRequest(body);
      const now = new Date().toISOString();
      const server = store.createMcpServer(input.serverInput, now);
      writeJson(response, 201, { server: toPublicMcpServer({ store, server, secretResolver, now }) });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /mcp/servers` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleMcpToolsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /mcp/tools` });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      tools: store.listMcpTools({
        serverId: url.searchParams.get("serverId") ?? undefined,
        enabled: readOptionalBooleanQuery(url, "enabled"),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMcpServerItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  mcpBroker: McpBroker,
  secretResolver: SecretResolver,
  route: { readonly serverId: string; readonly action?: "check" | "sync-tools" | "secret" | "status" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const server = store.getMcpServer(route.serverId);
    if (!server) {
      writeJson(response, 404, { error: "mcp_server_not_found", message: `MCP server not found: ${route.serverId}` });
      return;
    }

    if (request.method === "GET" && route.action === "secret") {
      writeJson(response, 410, {
        error: "mcp_secret_endpoint_removed",
        message: "MCP secret values are not readable. Use secret refs and /secrets/status.",
      });
      return;
    }

    if (request.method === "GET" && route.action === "status") {
      const now = new Date().toISOString();
      const statusSnapshot = store.getMcpStatusSnapshot(server.id, now);
      writeJson(response, 200, {
        server: toPublicMcpServer({ store, server, secretResolver, now }),
        statusSnapshot: statusSnapshot ?? null,
      });
      return;
    }

    if (request.method === "POST" && route.action === "check") {
      const now = new Date().toISOString();
      const result = await mcpBroker.checkServer(server, { secretResolver, now: () => now });
      const statusSnapshot = store.upsertMcpStatusSnapshot(result.statusSnapshot, now);
      const publicServer = toPublicMcpServer({ store, server, secretResolver, now });
      if (statusSnapshot.status === "ready" || statusSnapshot.status === "disabled") {
        writeJson(response, 200, { server: publicServer, statusSnapshot });
      } else {
        writeJson(response, 400, {
          error: "mcp_check_failed",
          message: statusSnapshot.message ?? "MCP check failed.",
          server: publicServer,
          statusSnapshot,
        });
      }
      return;
    }

    if (request.method === "POST" && route.action === "sync-tools") {
      const now = new Date().toISOString();
      const result = await mcpBroker.listTools(server, { secretResolver, now: () => now });
      const statusSnapshot = store.upsertMcpStatusSnapshot(result.statusSnapshot, now);
      if (statusSnapshot.status === "ready") {
        const cached = store.replaceMcpServerTools(server.id, result.tools, now);
        writeJson(response, 200, {
          server: toPublicMcpServer({ store, server, secretResolver, now }),
          statusSnapshot,
          tools: cached,
        });
      } else {
        writeJson(response, 400, {
          error: "mcp_tool_sync_failed",
          message: statusSnapshot.message ?? "MCP tool sync failed.",
          server: toPublicMcpServer({ store, server, secretResolver, now }),
          statusSnapshot,
          tools: [],
        });
      }
      return;
    }

    if (route.action) {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for MCP server ${route.action}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { server: toPublicMcpServer({ store, server, secretResolver, now: new Date().toISOString() }) });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseMcpServerUpdateRequest(body);
      const now = new Date().toISOString();
      let updated = store.updateMcpServer(server.id, input.serverInput, now) ?? server;
      updated = store.getMcpServer(server.id) ?? updated;
      writeJson(response, 200, { server: toPublicMcpServer({ store, server: updated, secretResolver, now }) });
      return;
    }

    if (request.method === "DELETE") {
      store.deleteMcpServer(server.id);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for MCP server` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
