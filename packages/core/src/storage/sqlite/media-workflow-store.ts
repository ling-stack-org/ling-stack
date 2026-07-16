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
  type MediaWorkflowDefinition,
  type MediaWorkflowVersion,
  type UpdateMediaWorkflowConnectionInput,
  type UpdateMediaWorkflowDefinitionInput,
} from "../../media-workflow-types.js";
import { stringifyJson } from "./helpers.js";
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
    this.context.database.prepare(`
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
