import type { ApprovalRequest } from "./approvals.js";

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
  readonly secretConfigured: boolean;
  readonly networkPolicy: MediaWorkflowNetworkPolicy;
  readonly protocolVariant: MediaWorkflowProtocolVariant;
  readonly status: MediaWorkflowConnectionStatus;
  readonly health?: MediaWorkflowConnectionHealth;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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

export interface MediaWorkflowAnalysis {
  readonly sourceDigest: string;
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
  readonly validation: MediaWorkflowValidationReport;
  readonly nodeClasses: readonly string[];
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

export interface MediaWorkflowDefinitionDetail {
  readonly definition: MediaWorkflowDefinition;
  readonly currentVersion?: MediaWorkflowVersion;
  readonly versions: readonly MediaWorkflowVersion[];
}

export interface CreateMediaWorkflowConnectionRequest {
  readonly name: string;
  readonly adapterKind?: MediaWorkflowAdapterKind;
  readonly baseUrl: string;
  readonly authMode: MediaWorkflowAuthMode;
  readonly apiKey?: string;
  readonly secretRef?: string;
  readonly networkPolicy: MediaWorkflowNetworkPolicy;
  readonly protocolVariant?: MediaWorkflowProtocolVariant;
}

export interface UpdateMediaWorkflowConnectionRequest {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly authMode?: MediaWorkflowAuthMode;
  readonly apiKey?: string;
  readonly secretRef?: string | null;
  readonly networkPolicy?: MediaWorkflowNetworkPolicy;
  readonly protocolVariant?: MediaWorkflowProtocolVariant;
  readonly enabled?: boolean;
}

export interface ImportMediaWorkflowRequest {
  readonly connectionId: string;
  readonly name: string;
  readonly description?: string;
  readonly fileName: string;
  readonly graph: Record<string, unknown>;
  readonly inputFields?: readonly MediaWorkflowInputField[];
  readonly outputRules?: readonly MediaWorkflowOutputRule[];
  readonly workflowDefinitionId?: string;
}

export interface UpdateMediaWorkflowVersionRequest {
  readonly inputFields: readonly MediaWorkflowInputField[];
  readonly outputRules: readonly MediaWorkflowOutputRule[];
}

export interface TestMediaWorkflowRequest {
  readonly inputValues: Record<string, unknown>;
}

export interface MediaWorkflowConnectionListResponse {
  readonly cwd: string;
  readonly connections: readonly MediaWorkflowConnection[];
}

export interface MediaWorkflowConnectionResponse {
  readonly connection: MediaWorkflowConnection;
}

export interface MediaWorkflowDefinitionListResponse {
  readonly cwd: string;
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
}

export interface MediaWorkflowDefinitionResponse extends MediaWorkflowDefinitionDetail {}

export interface MediaWorkflowImportResponse extends MediaWorkflowDefinitionDetail {
  readonly importedVersion: MediaWorkflowVersion;
  readonly analysis: MediaWorkflowAnalysis;
}

export interface MediaWorkflowTestResponse {
  readonly mediaJob: import("./media.js").MediaJob;
  readonly workflowDefinitionId: string;
  readonly workflowVersionId: string;
  readonly approval?: ApprovalRequest;
}

export interface MediaWorkflowDeleteResponse {
  readonly deleted: boolean;
  readonly connectionId?: string;
  readonly workflowDefinitionId?: string;
}
