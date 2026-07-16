import type { SQLOutputValue } from "node:sqlite";
import type {
  MediaWorkflowConnection,
  MediaWorkflowDefinition,
  MediaWorkflowVersion,
} from "../../media-workflow-types.js";
import {
  omitUndefined,
  parseJson,
  parseJsonObject,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapMediaWorkflowConnection(row: Record<string, SQLOutputValue>): MediaWorkflowConnection {
  const healthJson = readNullableString(row, "health_json");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    adapterKind: readString(row, "adapter_kind") as MediaWorkflowConnection["adapterKind"],
    baseUrl: readString(row, "base_url"),
    authMode: readString(row, "auth_mode") as MediaWorkflowConnection["authMode"],
    secretRef: readNullableString(row, "secret_ref"),
    networkPolicy: readString(row, "network_policy") as MediaWorkflowConnection["networkPolicy"],
    protocolVariant: readString(row, "protocol_variant") as MediaWorkflowConnection["protocolVariant"],
    status: readString(row, "status") as MediaWorkflowConnection["status"],
    health: healthJson ? parseJsonObject(healthJson) as unknown as MediaWorkflowConnection["health"] : undefined,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapMediaWorkflowDefinition(row: Record<string, SQLOutputValue>): MediaWorkflowDefinition {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    connectionId: readString(row, "connection_id"),
    name: readString(row, "name"),
    description: readNullableString(row, "description"),
    status: readString(row, "status") as MediaWorkflowDefinition["status"],
    currentVersionId: readNullableString(row, "current_version_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapMediaWorkflowVersion(row: Record<string, SQLOutputValue>): MediaWorkflowVersion {
  return omitUndefined({
    id: readString(row, "id"),
    workflowDefinitionId: readString(row, "workflow_definition_id"),
    version: readNumber(row, "version"),
    sourceFormat: "comfy_api_json" as const,
    sourceDigest: readString(row, "source_digest"),
    graphSnapshot: parseJsonObject(readString(row, "graph_snapshot_json")),
    inputFields: parseJson(readString(row, "input_fields_json")) as MediaWorkflowVersion["inputFields"],
    outputRules: parseJson(readString(row, "output_rules_json")) as MediaWorkflowVersion["outputRules"],
    validation: parseJsonObject(readString(row, "validation_json")) as unknown as MediaWorkflowVersion["validation"],
    testMediaJobId: readNullableString(row, "test_media_job_id"),
    createdAt: readString(row, "created_at"),
  });
}
