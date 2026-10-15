import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { redactSecrets } from "../../redaction.js";
import {
  createMediaWorkflowConnectionId,
  createMediaWorkflowDefinitionId,
  createMediaWorkflowVersionId,
  type CreateMediaWorkflowConnectionInput,
  type CreateMediaWorkflowDefinitionInput,
  type CreateMediaWorkflowVersionInput,
  type ListMediaWorkflowDefinitionsOptions,
  type MediaWorkflowConnection,
  type MediaWorkflowConnectionCheckAdmission,
  type MediaWorkflowConnectionCheckPublication,
  type MediaWorkflowConnectionCheckState,
  type MediaWorkflowConnectionCheckTicket,
  type MediaWorkflowConnectionHealth,
  type MediaWorkflowDefinition,
  type MediaWorkflowVersion,
  type UpdateMediaWorkflowConnectionInput,
  type UpdateMediaWorkflowDefinitionInput,
} from "../../media-workflow-types.js";
import { readNumber, rollbackOwnedSqliteTransaction, stringifyJson } from "./helpers.js";
import {
  mapMediaWorkflowConnection,
  mapMediaWorkflowDefinition,
  mapMediaWorkflowVersion,
} from "./media-workflow-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteMediaWorkflowStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  createConnection(input: CreateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection {
    const connection: MediaWorkflowConnection = {
      id: createMediaWorkflowConnectionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: requiredText(input.name, "Media workflow connection name is required"),
      adapterKind: input.adapterKind ?? "comfyui",
      baseUrl: requiredText(input.baseUrl, "Media workflow connection Base URL is required"),
      authMode: input.authMode,
      secretRef: input.secretRef,
      networkPolicy: input.networkPolicy,
      protocolVariant: input.protocolVariant ?? "auto",
      status: "unchecked",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO media_workflow_connections (
        id, workspace_id, name, adapter_kind, base_url, auth_mode, secret_ref,
        network_policy, protocol_variant, status, health_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      connection.id,
      connection.workspaceId,
      connection.name,
      connection.adapterKind,
      connection.baseUrl,
      connection.authMode,
      connection.secretRef ?? null,
      connection.networkPolicy,
      connection.protocolVariant,
      connection.status,
      null,
      connection.createdAt,
      connection.updatedAt,
    );
    return this.requireConnection(connection.id);
  }

  getConnection(id: string): MediaWorkflowConnection | undefined {
    const row = this.context.database.prepare(`
      SELECT id, workspace_id, name, adapter_kind, base_url, auth_mode, secret_ref,
             network_policy, protocol_variant, status, health_json, created_at, updated_at
      FROM media_workflow_connections WHERE id = ? AND workspace_id = ?
    `).get(id, DEFAULT_WORKSPACE_ID);
    return row ? mapMediaWorkflowConnection(row) : undefined;
  }

  listConnections(): MediaWorkflowConnection[] {
    return this.context.database.prepare(`
      SELECT id, workspace_id, name, adapter_kind, base_url, auth_mode, secret_ref,
             network_policy, protocol_variant, status, health_json, created_at, updated_at
      FROM media_workflow_connections
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `).all(DEFAULT_WORKSPACE_ID).map(mapMediaWorkflowConnection);
  }

  /** One statement binds the configuration to its durable authority. */
  getConnectionCheckState(id: string): MediaWorkflowConnectionCheckState | undefined {
    const statement = this.context.database.prepare(`SELECT connection.*, authority.config_revision,
      authority.request_revision, authority.published_revision
      FROM media_workflow_connections AS connection
      LEFT JOIN media_workflow_connection_check_authorities AS authority ON authority.connection_id=connection.id
      WHERE connection.id=? AND connection.workspace_id=?`);
    statement.setReadBigInts(true);
    const row = statement.get(id, DEFAULT_WORKSPACE_ID);
    if (!row) return undefined;
    const configRevision = readNumber(row, "config_revision");
    const requestRevision = readNumber(row, "request_revision");
    const publishedRevision = readNumber(row, "published_revision");
    if (!Number.isSafeInteger(configRevision) || configRevision < 1
      || !Number.isSafeInteger(requestRevision) || requestRevision < 0
      || !Number.isSafeInteger(publishedRevision) || publishedRevision < 0 || publishedRevision > requestRevision) {
      throw new Error("Invalid media workflow connection check authority.");
    }
    return { connection: mapMediaWorkflowConnection(row), configRevision, requestRevision, publishedRevision };
  }

  beginConnectionCheck(id: string): MediaWorkflowConnectionCheckAdmission | undefined {
    if (typeof id !== "string" || !id) throw new TypeError("Invalid media workflow connection check admission.");
    return this.writeCheck(() => {
      const state = this.getConnectionCheckState(id);
      if (!state) return undefined;
      if (state.requestRevision === Number.MAX_SAFE_INTEGER) {
        throw new Error("Media workflow connection check revision exhausted.");
      }
      const requestRevision = state.requestRevision + 1;
      const changed = this.context.database.prepare("UPDATE media_workflow_connection_check_authorities SET request_revision=? WHERE connection_id=?")
        .run(requestRevision, id);
      if (changed.changes !== 1) throw new Error("Media workflow connection check admission was not persisted.");
      return { connection: state.connection,
        ticket: { connectionId: id, configRevision: state.configRevision, requestRevision } };
    });
  }

  /** Health and request consumption commit together; no configuration write occurs. */
  commitConnectionCheck(ticket: MediaWorkflowConnectionCheckTicket, health: MediaWorkflowConnectionHealth, now: string): MediaWorkflowConnectionCheckPublication {
    if (!ticket || typeof ticket.connectionId !== "string" || !ticket.connectionId
      || !Number.isSafeInteger(ticket.configRevision) || ticket.configRevision < 1
      || !Number.isSafeInteger(ticket.requestRevision) || ticket.requestRevision < 1
      || typeof now !== "string" || !Number.isFinite(Date.parse(now))) throw new TypeError("Invalid media workflow connection check ticket.");
    assertConnectionHealth(health);
    return this.writeCheck(() => {
      const state = this.getConnectionCheckState(ticket.connectionId);
      if (!state) return { status: "stale", reason: "deleted" };
      if (state.configRevision !== ticket.configRevision) return { status: "stale", reason: "config_changed", connection: state.connection };
      if (state.requestRevision !== ticket.requestRevision) return { status: "stale", reason: "superseded", connection: state.connection };
      if (state.publishedRevision >= ticket.requestRevision) return { status: "stale", reason: "already_published", connection: state.connection };
      const updated = this.context.database.prepare(`UPDATE media_workflow_connections SET status=?, health_json=?, updated_at=?
        WHERE id=? AND workspace_id=?`).run(health.ok ? "ready" : "error", stringifyJson(redactSecrets(health)), now,
          ticket.connectionId, DEFAULT_WORKSPACE_ID);
      if (updated.changes !== 1) throw new Error("Media workflow connection check health was not persisted.");
      const consumed = this.context.database.prepare("UPDATE media_workflow_connection_check_authorities SET published_revision=? WHERE connection_id=?")
        .run(ticket.requestRevision, ticket.connectionId);
      if (consumed.changes !== 1) throw new Error("Media workflow connection check ticket was not consumed.");
      const connection = this.getConnection(ticket.connectionId);
      if (!connection) throw new Error("Media workflow connection disappeared during publication.");
      return { status: "published", connection };
    });
  }

  private writeCheck<T>(operation: () => T): T {
    let owned = false;
    try {
      this.context.database.exec("BEGIN IMMEDIATE");
      owned = true;
      const result = operation();
      this.context.database.exec("COMMIT");
      owned = false;
      return result;
    } catch (error) {
      if (owned) rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  updateConnection(id: string, input: UpdateMediaWorkflowConnectionInput, now: string): MediaWorkflowConnection | undefined {
    const existing = this.getConnection(id);
    if (!existing) {
      return undefined;
    }
    const next: MediaWorkflowConnection = {
      ...existing,
      name: input.name === undefined ? existing.name : requiredText(input.name, "Media workflow connection name is required"),
      baseUrl: input.baseUrl === undefined ? existing.baseUrl : requiredText(input.baseUrl, "Media workflow connection Base URL is required"),
      authMode: input.authMode ?? existing.authMode,
      secretRef: input.secretRef === undefined ? existing.secretRef : input.secretRef ?? undefined,
      networkPolicy: input.networkPolicy ?? existing.networkPolicy,
      protocolVariant: input.protocolVariant ?? existing.protocolVariant,
      status: input.status ?? existing.status,
      health: input.health === undefined ? existing.health : input.health ?? undefined,
      updatedAt: now,
    };
    // Explicit configuration writes (including equal-value/reset mutations)
    // activate the durable trigger. Health-only callers use a separate SET list.
    const configurationMutation = [input.name, input.baseUrl, input.authMode, input.secretRef,
      input.networkPolicy, input.protocolVariant].some(value => value !== undefined)
      || input.status === "disabled" || (input.status === "unchecked" && input.health === null);
    if (configurationMutation) this.context.database.prepare(`
      UPDATE media_workflow_connections
      SET name = ?, base_url = ?, auth_mode = ?, secret_ref = ?, network_policy = ?,
          protocol_variant = ?, status = ?, health_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      next.name,
      next.baseUrl,
      next.authMode,
      next.secretRef ?? null,
      next.networkPolicy,
      next.protocolVariant,
      next.status,
      next.health ? stringifyJson(redactSecrets(next.health)) : null,
      next.updatedAt,
      id,
      DEFAULT_WORKSPACE_ID,
    );
    else this.context.database.prepare(`UPDATE media_workflow_connections SET status=?, health_json=?, updated_at=?
      WHERE id=? AND workspace_id=?`).run(next.status, next.health ? stringifyJson(redactSecrets(next.health)) : null,
        now, id, DEFAULT_WORKSPACE_ID);
    return this.getConnection(id);
  }

  deleteConnection(id: string): boolean {
    const references = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM media_workflow_definitions WHERE connection_id = ?
    `).get(id) as { count: number | bigint };
    if (Number(references.count) > 0) {
      throw new Error("Media workflow connection is still referenced by workflows");
    }
    return this.context.database.prepare(`
      DELETE FROM media_workflow_connections WHERE id = ? AND workspace_id = ?
    `).run(id, DEFAULT_WORKSPACE_ID).changes > 0;
  }

  createDefinition(input: CreateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition {
    if (!this.getConnection(input.connectionId)) {
      throw new Error(`Media workflow connection not found: ${input.connectionId}`);
    }
    const definition: MediaWorkflowDefinition = {
      id: createMediaWorkflowDefinitionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      connectionId: input.connectionId,
      name: requiredText(input.name, "Media workflow name is required"),
      description: optionalText(input.description),
      status: input.status ?? "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO media_workflow_definitions (
        id, workspace_id, connection_id, name, description, status, current_version_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      definition.id,
      definition.workspaceId,
      definition.connectionId,
      definition.name,
      definition.description ?? null,
      definition.status,
      null,
      definition.createdAt,
      definition.updatedAt,
    );
    return this.requireDefinition(definition.id);
  }

  getDefinition(id: string): MediaWorkflowDefinition | undefined {
    const row = this.context.database.prepare(`
      SELECT id, workspace_id, connection_id, name, description, status, current_version_id, created_at, updated_at
      FROM media_workflow_definitions WHERE id = ? AND workspace_id = ?
    `).get(id, DEFAULT_WORKSPACE_ID);
    return row ? mapMediaWorkflowDefinition(row) : undefined;
  }

  listDefinitions(options: ListMediaWorkflowDefinitionsOptions = {}): MediaWorkflowDefinition[] {
    const clauses = ["workspace_id = ?"];
    const params: string[] = [DEFAULT_WORKSPACE_ID];
    if (options.connectionId) {
      clauses.push("connection_id = ?");
      params.push(options.connectionId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    return this.context.database.prepare(`
      SELECT id, workspace_id, connection_id, name, description, status, current_version_id, created_at, updated_at
      FROM media_workflow_definitions
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, created_at DESC
    `).all(...params).map(mapMediaWorkflowDefinition);
  }

  updateDefinition(id: string, input: UpdateMediaWorkflowDefinitionInput, now: string): MediaWorkflowDefinition | undefined {
    const existing = this.getDefinition(id);
    if (!existing) {
      return undefined;
    }
    const connectionId = input.connectionId ?? existing.connectionId;
    if (!this.getConnection(connectionId)) {
      throw new Error(`Media workflow connection not found: ${connectionId}`);
    }
    const currentVersionId = input.currentVersionId === undefined
      ? existing.currentVersionId
      : input.currentVersionId ?? undefined;
    if (currentVersionId) {
      const version = this.getVersion(currentVersionId);
      if (!version || version.workflowDefinitionId !== id) {
        throw new Error("Media workflow version does not belong to this workflow");
      }
    }
    this.context.database.prepare(`
      UPDATE media_workflow_definitions
      SET connection_id = ?, name = ?, description = ?, status = ?, current_version_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      connectionId,
      input.name === undefined ? existing.name : requiredText(input.name, "Media workflow name is required"),
      input.description === undefined ? existing.description ?? null : optionalText(input.description) ?? null,
      input.status ?? existing.status,
      currentVersionId ?? null,
      now,
      id,
      DEFAULT_WORKSPACE_ID,
    );
    return this.getDefinition(id);
  }

  deleteDefinition(id: string): boolean {
    const runReference = this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM media_jobs
      WHERE workflow_version_id IN (
        SELECT id FROM media_workflow_versions WHERE workflow_definition_id = ?
      )
    `).get(id) as { count: number | bigint };
    if (Number(runReference.count) > 0) {
      throw new Error("Media workflow has run history and must be archived instead of deleted");
    }
    return this.context.database.prepare(`
      DELETE FROM media_workflow_definitions WHERE id = ? AND workspace_id = ?
    `).run(id, DEFAULT_WORKSPACE_ID).changes > 0;
  }

  createVersion(input: CreateMediaWorkflowVersionInput, now: string): MediaWorkflowVersion {
    if (!this.getDefinition(input.workflowDefinitionId)) {
      throw new Error(`Media workflow not found: ${input.workflowDefinitionId}`);
    }
    const row = this.context.database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM media_workflow_versions WHERE workflow_definition_id = ?
    `).get(input.workflowDefinitionId) as { version: number | bigint };
    const version: MediaWorkflowVersion = {
      id: createMediaWorkflowVersionId(),
      workflowDefinitionId: input.workflowDefinitionId,
      version: Number(row.version) + 1,
      sourceFormat: "comfy_api_json",
      sourceDigest: input.sourceDigest,
      graphSnapshot: redactSecrets(input.graphSnapshot) as Record<string, unknown>,
      inputFields: input.inputFields,
      outputRules: input.outputRules,
      validation: input.validation,
      testMediaJobId: input.testMediaJobId,
      createdAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO media_workflow_versions (
        id, workflow_definition_id, version, source_format, source_digest, graph_snapshot_json,
        input_fields_json, output_rules_json, validation_json, test_media_job_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      version.id,
      version.workflowDefinitionId,
      version.version,
      version.sourceFormat,
      version.sourceDigest,
      stringifyJson(version.graphSnapshot),
      stringifyJson(version.inputFields),
      stringifyJson(version.outputRules),
      stringifyJson(version.validation),
      version.testMediaJobId ?? null,
      version.createdAt,
    );
    return this.requireVersion(version.id);
  }

  getVersion(id: string): MediaWorkflowVersion | undefined {
    const row = this.context.database.prepare(`
      SELECT id, workflow_definition_id, version, source_format, source_digest, graph_snapshot_json,
             input_fields_json, output_rules_json, validation_json, test_media_job_id, created_at
      FROM media_workflow_versions WHERE id = ?
    `).get(id);
    return row ? mapMediaWorkflowVersion(row) : undefined;
  }

  listVersions(workflowDefinitionId: string): MediaWorkflowVersion[] {
    return this.context.database.prepare(`
      SELECT id, workflow_definition_id, version, source_format, source_digest, graph_snapshot_json,
             input_fields_json, output_rules_json, validation_json, test_media_job_id, created_at
      FROM media_workflow_versions WHERE workflow_definition_id = ?
      ORDER BY version DESC
    `).all(workflowDefinitionId).map(mapMediaWorkflowVersion);
  }

  setVersionTestJob(id: string, mediaJobId: string): MediaWorkflowVersion | undefined {
    if (!this.getVersion(id)) {
      return undefined;
    }
    if (!this.context.database.prepare("SELECT 1 AS found FROM media_jobs WHERE id = ?").get(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    this.context.database.prepare(`
      UPDATE media_workflow_versions SET test_media_job_id = ? WHERE id = ?
    `).run(mediaJobId, id);
    return this.getVersion(id);
  }

  private requireConnection(id: string): MediaWorkflowConnection {
    const value = this.getConnection(id);
    if (!value) {
      throw new Error(`Failed to persist media workflow connection: ${id}`);
    }
    return value;
  }

  private requireDefinition(id: string): MediaWorkflowDefinition {
    const value = this.getDefinition(id);
    if (!value) {
      throw new Error(`Failed to persist media workflow: ${id}`);
    }
    return value;
  }

  private requireVersion(id: string): MediaWorkflowVersion {
    const value = this.getVersion(id);
    if (!value) {
      throw new Error(`Failed to persist media workflow version: ${id}`);
    }
    return value;
  }
}

function requiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function optionalText(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function assertConnectionHealth(health: MediaWorkflowConnectionHealth): void {
  if (!health || typeof health !== "object" || Array.isArray(health)
    || typeof health.ok !== "boolean" || typeof health.message !== "string"
    || typeof health.checkedAt !== "string" || !Number.isFinite(Date.parse(health.checkedAt))
    || (health.protocolVariant !== undefined && health.protocolVariant !== "jobs_v1" && health.protocolVariant !== "prompt_legacy")
    || (health.nodeCount !== undefined && (!Number.isSafeInteger(health.nodeCount) || health.nodeCount < 0))
    || Object.keys(health).some(key => !["ok", "message", "checkedAt", "protocolVariant", "nodeCount"].includes(key))) {
    throw new TypeError("Invalid media workflow connection check health.");
  }
}
