import type { DatabaseSync } from "node:sqlite";
import type {
  CommitMcpMetadataResult,
  CommitMcpMetadataResultInput,
  McpMetadataRequestKind,
  McpMetadataRequestTicket,
} from "../../mcp-metadata-types.js";
import { readNumber, rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteMcpStore } from "./mcp-store.js";
import type { SqliteControlPlaneStore } from "./control-plane-store.js";

/** Owns only manual metadata admission/publication, never network or tool execution. */
export class SqliteMcpMetadataPublicationStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly mcps: SqliteMcpStore,
    private readonly events: SqliteControlPlaneStore,
  ) {}

  beginMcpMetadataRequest(serverId: string, kind: McpMetadataRequestKind): McpMetadataRequestTicket | undefined {
    if (!serverId || (kind !== "check" && kind !== "sync-tools")) {
      throw new TypeError("Invalid MCP metadata request.");
    }
    return this.write(() => {
      const server = this.mcps.getMcpServer(serverId);
      if (!server) return undefined;
      const authority = this.readAuthority(serverId);
      if (!authority || authority.requestRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error("Invalid MCP metadata authority or exhausted request revision.");
      }
      const requestRevision = authority.requestRevision + 1;
      this.database.prepare(`
        UPDATE mcp_authority_revisions SET metadata_request_revision = ? WHERE server_id = ?
      `).run(requestRevision, serverId);
      return { server, kind, requestRevision, serverRevision: authority.serverRevision, toolsRevision: authority.toolsRevision };
    });
  }

  commitMcpMetadataResult(input: CommitMcpMetadataResultInput): CommitMcpMetadataResult {
    assertInput(input);
    return this.write(() => {
      const { request } = input;
      const server = this.mcps.getMcpServer(request.server.id);
      if (!server) return { published: false, reason: "deleted" };
      const authority = this.readAuthority(server.id);
      if (!authority) throw new Error("Invalid MCP metadata authority.");
      if (authority.serverRevision !== request.serverRevision) return { published: false, reason: "server_changed" };
      if (authority.requestRevision !== request.requestRevision) return { published: false, reason: "superseded" };
      if (authority.publishedRevision >= request.requestRevision) return { published: false, reason: "already_published" };
      if (authority.toolsRevision !== request.toolsRevision) return { published: false, reason: "tools_changed" };

      const readySync = request.kind === "sync-tools" && input.statusSnapshot.status === "ready";
      const tools = readySync ? this.mcps.replaceMcpServerTools(server.id, input.tools!, input.now) : undefined;
      // The public catalog read is bounded at 500. Persist factual count, not page length.
      const toolCount = readySync
        ? readNumber(this.database.prepare("SELECT COUNT(*) AS count FROM mcp_tools WHERE server_id = ?").get(server.id), "count")
        : input.statusSnapshot.toolCount;
      const statusSnapshot = this.mcps.upsertMcpStatusSnapshot({
        ...input.statusSnapshot,
        ...(readySync ? { toolCount } : {}),
      }, input.now);
      this.database.prepare(`
        UPDATE mcp_authority_revisions SET metadata_published_revision = ? WHERE server_id = ?
      `).run(request.requestRevision, server.id);
      const event = this.events.appendControlPlaneEventWithinTransaction({
        workspaceId: server.workspaceId,
        cwd: input.cwd,
        domain: "mcp",
        entityType: "mcp_server",
        entityId: server.id,
        action: request.kind === "check" ? "mcp.status_checked" : readySync ? "mcp.tools_synced" : "mcp.tools_sync_failed",
        data: {
          serverId: server.id,
          status: statusSnapshot.status,
          toolCount: statusSnapshot.toolCount ?? 0,
          missingSecretCount: statusSnapshot.missingSecretRefs.length,
        },
      }, input.now);
      return { published: true, server, statusSnapshot, ...(tools ? { tools } : {}), event };
    });
  }

  private readAuthority(serverId: string): {
    readonly serverRevision: number;
    readonly toolsRevision: number;
    readonly requestRevision: number;
    readonly publishedRevision: number;
  } | undefined {
    const statement = this.database.prepare(`
      SELECT server_revision, tools_revision, metadata_request_revision, metadata_published_revision
      FROM mcp_authority_revisions WHERE server_id = ?
    `);
    // Read exact SQLite integers before checking JS's safe revision range.
    statement.setReadBigInts(true);
    const row = statement.get(serverId);
    if (!row) return undefined;
    const value = {
      serverRevision: readNumber(row, "server_revision"),
      toolsRevision: readNumber(row, "tools_revision"),
      requestRevision: readNumber(row, "metadata_request_revision"),
      publishedRevision: readNumber(row, "metadata_published_revision"),
    };
    if (Object.values(value).some(revision => !Number.isSafeInteger(revision) || revision < 0)
      || value.publishedRevision > value.requestRevision) {
      throw new Error("Invalid MCP metadata authority revision.");
    }
    return value;
  }

  /** BEGIN failure never adopts or rolls back another caller's transaction. */
  private write<T>(operation: () => T): T {
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      began = true;
      const result = operation();
      this.database.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) rollbackOwnedSqliteTransaction(this.database);
      throw error;
    }
  }
}

function assertInput(input: CommitMcpMetadataResultInput): void {
  const request = input?.request;
  if (!request?.server?.id || (request.kind !== "check" && request.kind !== "sync-tools")
    || !Number.isSafeInteger(request.requestRevision) || request.requestRevision < 1
    || !Number.isSafeInteger(request.serverRevision) || request.serverRevision < 0
    || !Number.isSafeInteger(request.toolsRevision) || request.toolsRevision < 0
    || input.statusSnapshot?.serverId !== request.server.id
    || !input.cwd || !input.now
    || (request.kind === "check" && input.tools !== undefined)
    || (request.kind === "sync-tools" && input.statusSnapshot.status === "ready" && !Array.isArray(input.tools))) {
    throw new TypeError("Invalid MCP metadata publication input.");
  }
}
