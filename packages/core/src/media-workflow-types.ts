import { randomUUID } from "node:crypto";

export type MediaExecutionMode = "direct" | "workflow";
export type MediaSceneExecutionMode = "inherit" | MediaExecutionMode;
export type MediaWorkflowAdapterKind = "comfyui";
export type MediaWorkflowAuthMode = "none" | "bearer";
export type MediaWorkflowNetworkPolicy = "public_only" | "trusted_private_network";
export type MediaWorkflowProtocolVariant = "auto" | "jobs_v1" | "prompt_legacy";
export type MediaWorkflowConnectionStatus = "unchecked" | "ready" | "error" | "disabled";
export type MediaWorkflowDefinitionStatus = "draft" | "ready" | "blocked" | "archived";
export type MediaWorkflowInputKind = "text" | "number" | "boolean" | "select" | "image_artifact";
export type MediaWorkflowInputSemantic =
  | "prompt"
  | "negative_prompt"
  | "ratio"
  | "duration"
  | "seed"
  | "reference_image"
  | "custom";
export type MediaWorkflowArtifactType = "image" | "video";

export type MediaExecutionSource =
  | { readonly kind: "provider"; readonly providerPresetId: string }
  | { readonly kind: "workflow"; readonly workflowVersionId: string };

export interface MediaWorkflowConnectionHealth {
  readonly ok: boolean;
  readonly message: string;
  readonly checkedAt: string;
  readonly protocolVariant?: Exclude<MediaWorkflowProtocolVariant, "auto">;
  readonly nodeCount?: number;
}

export interface MediaWorkflowConnection {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly adapterKind: MediaWorkflowAdapterKind;
  readonly baseUrl: string;
  readonly authMode: MediaWorkflowAuthMode;
  readonly secretRef?: string;
  readonly networkPolicy: MediaWorkflowNetworkPolicy;
  readonly protocolVariant: MediaWorkflowProtocolVariant;
  readonly status: MediaWorkflowConnectionStatus;
  readonly health?: MediaWorkflowConnectionHealth;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Host-only authority; credentials and their proofs never enter this record. */
export interface MediaWorkflowConnectionCheckState {
  readonly connection: MediaWorkflowConnection;
  readonly configRevision: number;
  readonly requestRevision: number;
  readonly publishedRevision: number;
}

export interface MediaWorkflowConnectionCheckTicket {
  readonly connectionId: string;
  readonly configRevision: number;
  readonly requestRevision: number;
}

export interface MediaWorkflowConnectionCheckAdmission {
  readonly connection: MediaWorkflowConnection;
  readonly ticket: MediaWorkflowConnectionCheckTicket;
}

export type MediaWorkflowConnectionCheckStaleReason =
  | "deleted" | "config_changed" | "superseded" | "already_published"
  | "credential_changed" | "credential_unavailable";

export type MediaWorkflowConnectionCheckPublication =
  | { readonly status: "published"; readonly connection: MediaWorkflowConnection }
  | { readonly status: "stale"; readonly reason: MediaWorkflowConnectionCheckStaleReason;
      readonly connection?: MediaWorkflowConnection };

export interface MediaWorkflowInputField {
  readonly id: string;
  readonly label: string;
  readonly kind: MediaWorkflowInputKind;
  readonly semantic: MediaWorkflowInputSemantic;
  readonly required: boolean;
  readonly nodeId: string;
  readonly inputName: string;
  readonly defaultValue?: unknown;
  readonly options?: readonly string[];
}

export interface MediaWorkflowOutputRule {
  readonly nodeId: string;
  readonly artifactType: MediaWorkflowArtifactType;
  readonly collect: "first" | "all";
}

export interface MediaWorkflowValidationReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly checkedAt: string;
}

export interface MediaWorkflowVersion {
  readonly id: string;
  readonly workflowDefinitionId: string;
  readonly version: number;
  readonly sourceFormat: "comfy_api_json";
  readonly sourceDigest: string;
  readonly graphSnapshot: Record<string, unknown>;
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
  readonly validation: MediaWorkflowValidationReport;
  readonly testMediaJobId?: string;
  readonly createdAt: string;
}

export interface MediaWorkflowDefinition {
  readonly id: string;
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly name: string;
  readonly description?: string;
  readonly status: MediaWorkflowDefinitionStatus;
  readonly currentVersionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMediaWorkflowConnectionInput {
  readonly name: string;
  readonly adapterKind?: MediaWorkflowAdapterKind;
  readonly baseUrl: string;
  readonly authMode: MediaWorkflowAuthMode;
  readonly secretRef?: string;
  readonly networkPolicy: MediaWorkflowNetworkPolicy;
  readonly protocolVariant?: MediaWorkflowProtocolVariant;
}

export interface UpdateMediaWorkflowConnectionInput {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly authMode?: MediaWorkflowAuthMode;
  readonly secretRef?: string | null;
  readonly networkPolicy?: MediaWorkflowNetworkPolicy;
  readonly protocolVariant?: MediaWorkflowProtocolVariant;
  readonly status?: MediaWorkflowConnectionStatus;
  readonly health?: MediaWorkflowConnectionHealth | null;
}

export interface CreateMediaWorkflowDefinitionInput {
  readonly connectionId: string;
  readonly name: string;
  readonly description?: string;
  readonly status?: MediaWorkflowDefinitionStatus;
}

export interface UpdateMediaWorkflowDefinitionInput {
  readonly connectionId?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly status?: MediaWorkflowDefinitionStatus;
  readonly currentVersionId?: string | null;
}

export interface CreateMediaWorkflowVersionInput {
  readonly workflowDefinitionId: string;
  readonly sourceDigest: string;
  readonly graphSnapshot: Record<string, unknown>;
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
  readonly validation: MediaWorkflowValidationReport;
  readonly testMediaJobId?: string;
}

export interface ListMediaWorkflowDefinitionsOptions {
  readonly connectionId?: string;
  readonly status?: MediaWorkflowDefinitionStatus;
}

export function createMediaWorkflowConnectionId(): string {
  return `media_workflow_connection_${randomUUID()}`;
}

export function createMediaWorkflowDefinitionId(): string {
  return `media_workflow_${randomUUID()}`;
}

export function createMediaWorkflowVersionId(): string {
  return `media_workflow_version_${randomUUID()}`;
}
