import {
  DEFAULT_WORKSPACE_ID,
  isLingAgentTeammateId,
  type AiTeammate,
} from "../../workspace-types.js";
import {
  createMcpServerId,
  type CreateMcpServerInput,
  type ListMcpServersOptions,
  type ListMcpToolsOptions,
  type McpAuthorityRevision,
  type McpRuntimeStatusSnapshot,
  type McpServer,
  type McpServerStatus,
  type McpTool,
  type ReplaceMcpServerToolInput,
  type ReplaceTeammateMcpBindingInput,
  type TeammateMcpBinding,
  type UpdateMcpServerInput,
} from "../../mcp-types.js";
import {
  nullableUpdate,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import {
  mapMcpServer,
  mapMcpTool,
  mapTeammateMcpBinding,
  normalizeMcpServerTransport,
  parseMcpRuntimeStatusSnapshot,
} from "./mcp-mappers.js";
import {
  mcpServerSelectSql,
  mcpToolSelectSql,
  teammateMcpBindingSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteMcpStorePorts {
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
}

export class SqliteMcpStore {
  private readonly context: SqliteStoreContext;
  private readonly ports: SqliteMcpStorePorts;

  constructor(context: SqliteStoreContext, ports: SqliteMcpStorePorts) {
    this.context = context;
    this.ports = ports;
  }

  createMcpServer(input: CreateMcpServerInput, now: string): McpServer {
    const server: McpServer = {
      id: input.id ?? createMcpServerId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName: input.displayName,
      transport: normalizeMcpServerTransport(input.transport),
      enabled: input.enabled ?? true,
      required: input.required ?? false,
      status: input.status ?? { kind: "unknown" },
      startupTimeoutSec: input.startupTimeoutSec,
      toolTimeoutSec: input.toolTimeoutSec,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO mcp_servers (
          id,
          workspace_id,
          display_name,
          transport_json,
          enabled,
          required,
          status_json,
          startup_timeout_sec,
          tool_timeout_sec,
          enabled_tools_json,
          disabled_tools_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        server.id,
        server.workspaceId,
        server.displayName,
        stringifyJson(server.transport),
        server.enabled ? 1 : 0,
        server.required ? 1 : 0,
        stringifyJson(server.status),
        server.startupTimeoutSec ?? null,
        server.toolTimeoutSec ?? null,
        server.enabledTools ? stringifyJson(server.enabledTools) : null,
        stringifyJson(server.disabledTools),
        server.createdAt,
        server.updatedAt,
      );

    const created = this.getMcpServer(server.id);
    if (!created) {
      throw new Error(`Failed to create MCP server: ${server.id}`);
    }
    return created;
  }

  getMcpServer(id: string): McpServer | undefined {
    const row = this.context.database.prepare(mcpServerSelectSql("WHERE id = ?")).get(id);
    return row ? mapMcpServer(row) : undefined;
  }

  getMcpAuthorityRevision(serverId: string): McpAuthorityRevision | undefined {
    const row = this.context.database
      .prepare(`
        SELECT server_revision, tools_revision
        FROM mcp_authority_revisions
        WHERE server_id = ?
      `)
      .get(serverId);
    return row
      ? {
          serverRevision: readNumber(row, "server_revision"),
          toolsRevision: readNumber(row, "tools_revision"),
        }
      : undefined;
  }

  listMcpServers(options: ListMcpServersOptions = {}): McpServer[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${mcpServerSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMcpServer);
  }

  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined {
    const existing = this.getMcpServer(id);
    if (!existing) {
      return undefined;
    }
    const next: McpServer = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      transport: input.transport ? normalizeMcpServerTransport(input.transport) : existing.transport,
      enabled: input.enabled ?? existing.enabled,
      required: input.required ?? existing.required,
      status: input.status ?? existing.status,
      startupTimeoutSec: nullableUpdate(input.startupTimeoutSec, existing.startupTimeoutSec),
      toolTimeoutSec: nullableUpdate(input.toolTimeoutSec, existing.toolTimeoutSec),
      enabledTools: nullableUpdate(input.enabledTools, existing.enabledTools),
      disabledTools: input.disabledTools ?? existing.disabledTools,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        UPDATE mcp_servers
        SET
          display_name = ?,
          transport_json = ?,
          enabled = ?,
          required = ?,
          status_json = ?,
          startup_timeout_sec = ?,
          tool_timeout_sec = ?,
          enabled_tools_json = ?,
          disabled_tools_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.displayName,
        stringifyJson(next.transport),
        next.enabled ? 1 : 0,
        next.required ? 1 : 0,
        stringifyJson(next.status),
        next.startupTimeoutSec ?? null,
        next.toolTimeoutSec ?? null,
        next.enabledTools ? stringifyJson(next.enabledTools) : null,
        stringifyJson(next.disabledTools),
        next.updatedAt,
        id,
      );

    return this.getMcpServer(id);
  }

  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined {
    return this.updateMcpServer(id, { status }, now);
  }

  upsertMcpStatusSnapshot(snapshot: McpRuntimeStatusSnapshot, now: string): McpRuntimeStatusSnapshot {
    if (!this.getMcpServer(snapshot.serverId)) {
      throw new Error(`MCP server not found: ${snapshot.serverId}`);
    }
    this.context.database
      .prepare(`
        INSERT INTO mcp_status_snapshots (
          server_id,
          status_json,
          checked_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          status_json = excluded.status_json,
          checked_at = excluded.checked_at,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(snapshot.serverId, stringifyJson(snapshot), snapshot.checkedAt, snapshot.expiresAt, now, now);
    const stored = this.getMcpStatusSnapshot(snapshot.serverId);
    if (!stored) {
      throw new Error(`Failed to persist MCP status snapshot: ${snapshot.serverId}`);
    }
    return stored;
  }

  getMcpStatusSnapshot(serverId: string, now?: string): McpRuntimeStatusSnapshot | undefined {
    const row = this.context.database
      .prepare("SELECT status_json, expires_at FROM mcp_status_snapshots WHERE server_id = ?")
      .get(serverId);
    if (!row) {
      return undefined;
    }
    const expiresAt = readString(row, "expires_at");
    const snapshot = parseMcpRuntimeStatusSnapshot(readString(row, "status_json"));
    if (now && expiresAt <= now) {
      return {
        ...snapshot,
        status: "expired",
        message: snapshot.message ?? "MCP status snapshot expired.",
      };
    }
    return snapshot;
  }

  deleteMcpStatusSnapshot(serverId: string): boolean {
    const result = this.context.database.prepare("DELETE FROM mcp_status_snapshots WHERE server_id = ?").run(serverId);
    return Number(result.changes) > 0;
  }

  countLegacyMcpServerSecrets(serverId?: string): number {
    const row = serverId
      ? this.context.database.prepare("SELECT COUNT(*) AS count FROM mcp_server_secrets WHERE server_id = ?").get(serverId)
      : this.context.database.prepare("SELECT COUNT(*) AS count FROM mcp_server_secrets").get();
    return row ? readNumber(row, "count") : 0;
  }

  listLegacyMcpServerSecretNames(serverId: string): readonly string[] {
    return this.context.database
      .prepare("SELECT secret_name FROM mcp_server_secrets WHERE server_id = ? ORDER BY secret_name ASC")
      .all(serverId)
      .map((row) => readString(row, "secret_name"));
  }

  deleteMcpServer(id: string): boolean {
    const result = this.context.database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void {
    void serverId;
    void secretName;
    void secretValue;
    void now;
    throw new Error("MCP raw secret writes are disabled; store secret refs in MCP transport config.");
  }

  getMcpServerSecret(serverId: string, secretName: string): string | undefined {
    const row = this.context.database
      .prepare("SELECT secret_value FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .get(serverId, secretName);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasMcpServerSecret(serverId: string, secretName: string): boolean {
    return Boolean(
      this.context.database
        .prepare("SELECT 1 AS found FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
        .get(serverId, secretName),
    );
  }

  deleteMcpServerSecret(serverId: string, secretName: string): boolean {
    const result = this.context.database
      .prepare("DELETE FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .run(serverId, secretName);
    return Number(result.changes) > 0;
  }

  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[] {
    if (!this.getMcpServer(serverId)) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    // Replacement owns the complete catalog, not the capped public listing page.
    const existingFirstSeen = new Map(this.context.database.prepare(
      "SELECT raw_name, first_seen_at FROM mcp_tools WHERE server_id = ?",
    ).all(serverId).map(row => [readString(row, "raw_name"), readString(row, "first_seen_at")]));
    this.context.database.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId);
    const insert = this.context.database.prepare(`
      INSERT INTO mcp_tools (
        server_id,
        raw_name,
        display_name,
        description,
        input_schema_json,
        callable_namespace,
        callable_name,
        side_effect_level,
        default_approval,
        enabled,
        first_seen_at,
        last_seen_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const tool of dedupeMcpToolInputs(tools)) {
      insert.run(
        serverId,
        tool.rawName,
        tool.displayName,
        tool.description ?? null,
        stringifyJson(tool.inputSchema),
        tool.callableNamespace,
        tool.callableName,
        tool.sideEffectLevel,
        tool.defaultApproval,
        tool.enabled === false ? 0 : 1,
        existingFirstSeen.get(tool.rawName) ?? now,
        now,
        now,
      );
    }
    return this.listMcpTools({ serverId, limit: 500 });
  }

  listMcpTools(options: ListMcpToolsOptions = {}): McpTool[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.serverId) {
      clauses.push("server_id = ?");
      params.push(options.serverId);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${mcpToolSelectSql(whereClause)} ORDER BY server_id ASC, raw_name ASC LIMIT ?`)
      .all(...params)
      .map(mapMcpTool);
  }

  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[] {
    if (!this.ports.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    if (isLingAgentTeammateId(teammateId)) {
      throw new Error("Ling Agent MCP bindings are protected.");
    }
    this.context.database.prepare("DELETE FROM teammate_mcp_bindings WHERE teammate_id = ?").run(teammateId);
    const insert = this.context.database.prepare(`
      INSERT INTO teammate_mcp_bindings (
        teammate_id,
        server_id,
        mode,
        selected_tool_names_json,
        approval_overrides_json,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const binding of dedupeTeammateMcpBindingInputs(bindings)) {
      if (!this.getMcpServer(binding.serverId)) {
        throw new Error(`MCP server not found: ${binding.serverId}`);
      }
      insert.run(
        teammateId,
        binding.serverId,
        binding.mode,
        stringifyJson(binding.selectedToolNames ?? []),
        stringifyJson(binding.approvalOverrides ?? {}),
        binding.enabled === false ? 0 : 1,
        now,
        now,
      );
    }
    return this.listTeammateMcpBindings(teammateId);
  }

  upsertLingAgentChromeBrowserBinding(enabled: boolean, now: string): TeammateMcpBinding {
    return this.upsertLingAgentBuiltInMcpBinding("mcp_chrome_browser", enabled, now);
  }

  upsertLingAgentBuiltInMcpBinding(serverId: string, enabled: boolean, now: string): TeammateMcpBinding {
    const teammateId = "ling_agent";
    if (!this.ports.getAiTeammate(teammateId)) {
      throw new Error("Ling Agent is unavailable.");
    }
    if (!this.getMcpServer(serverId)) {
      throw new Error(`Built-in MCP server is unavailable: ${serverId}`);
    }
    this.context.database.prepare(`
      INSERT INTO teammate_mcp_bindings (
        teammate_id, server_id, mode, selected_tool_names_json,
        approval_overrides_json, enabled, created_at, updated_at
      ) VALUES (?, ?, 'all_current_tools', '[]', '{}', ?, ?, ?)
      ON CONFLICT(teammate_id, server_id) DO UPDATE SET
        mode = 'all_current_tools',
        selected_tool_names_json = '[]',
        approval_overrides_json = '{}',
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(teammateId, serverId, enabled ? 1 : 0, now, now);
    const binding = this.listTeammateMcpBindings(teammateId).find((candidate) => candidate.serverId === serverId);
    if (!binding) throw new Error("Failed to persist Ling Agent built-in MCP binding.");
    return binding;
  }

  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[] {
    return this.context.database
      .prepare(`${teammateMcpBindingSelectSql("WHERE teammate_id = ?")} ORDER BY server_id ASC`)
      .all(teammateId)
      .map(mapTeammateMcpBinding);
  }
}

function dedupeMcpToolInputs(tools: readonly ReplaceMcpServerToolInput[]): readonly ReplaceMcpServerToolInput[] {
  const byRawName = new Map<string, ReplaceMcpServerToolInput>();
  for (const tool of tools) {
    byRawName.set(tool.rawName, tool);
  }
  return [...byRawName.values()];
}

function dedupeTeammateMcpBindingInputs(
  bindings: readonly ReplaceTeammateMcpBindingInput[],
): readonly ReplaceTeammateMcpBindingInput[] {
  const byServer = new Map<string, ReplaceTeammateMcpBindingInput>();
  for (const binding of bindings) {
    byServer.set(binding.serverId, binding);
  }
  return [...byServer.values()];
}
