import type { MediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import type { StatusTone } from "../../shared/ui/index.js";
import type { MediaJob, MediaJobFormState, MediaOperation, RunArtifact } from "../../types.js";

export type MediaJobProductState =
  | "ready_to_start"
  | "starting"
  | "generating"
  | "waiting_for_review"
  | "needs_attention"
  | "completed"
  | "unknown";

export type MediaJobStatusFilter = "all" | "ready_to_start" | "generating" | "needs_attention" | "completed";

export type MediaJobActionId =
  | "start"
  | "retry"
  | "open_approval"
  | "repair_provider"
  | "repair_workflow"
  | "repair_connection"
  | "refresh"
  | "view_result"
  | "download"
  | "copy_prompt"
  | "copy_result_link"
  | "reuse_settings";

export interface MediaJobActionView {
  readonly id: MediaJobActionId;
  readonly labelKey: string;
  readonly disabled: boolean;
  readonly disabledReasonKey?: string;
  readonly emphasis: "primary" | "secondary";
}

export type MediaWorkflowConnectionView =
  | { readonly kind: "available"; readonly id: string; readonly status: "unchecked" | "ready" | "error" | "disabled" }
  | { readonly kind: "missing"; readonly id: string };

export type MediaJobSourceView =
  | { readonly kind: "provider"; readonly id: string; readonly name: string; readonly runtime: MediaProviderRuntimeState }
  | { readonly kind: "provider_missing"; readonly id: string }
  | {
    readonly kind: "workflow";
    readonly versionId: string;
    readonly definitionId: string;
    readonly name: string;
    readonly status: "draft" | "ready" | "blocked" | "archived";
    readonly connection: MediaWorkflowConnectionView;
  }
  | { readonly kind: "workflow_missing"; readonly versionId: string; readonly reason: "version_missing" | "definition_missing" };

export type MediaJobApprovalView =
  | { readonly kind: "none" }
  | { readonly kind: "pending"; readonly id: string }
  | { readonly kind: "missing" };

export interface MediaJobResultView {
  readonly state: "loading" | "ready" | "missing" | "unavailable" | "none";
  readonly primary?: RunArtifact;
  readonly mediaArtifacts: readonly RunArtifact[];
  readonly auxiliaryArtifacts: readonly RunArtifact[];
  readonly errorMessage?: string;
}

export interface MediaJobRowView {
  readonly jobId: string;
  readonly identity: { readonly title: string; readonly description: string; readonly titleTooltip?: string };
  readonly meta: readonly string[];
  readonly status: { readonly id: MediaJobProductState; readonly labelKey: string; readonly tone: StatusTone };
  readonly primaryAction?: MediaJobActionView;
  readonly preview: { readonly kind: "image" | "video" | "loading" | "empty"; readonly artifact?: RunArtifact };
  readonly stale: boolean;
}

export interface MediaJobRepairView {
  readonly tone: "warning" | "danger";
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly primaryAction: MediaJobActionView;
  readonly rawDetails: string;
}

export type MediaJobFieldId =
  | "workspace"
  | "operation"
  | "providerPresetId"
  | "prompt"
  | "imageUrl"
  | "maskUrl"
  | "count"
  | "seed"
  | "duration";

export type MediaJobFormErrors = Partial<Record<MediaJobFieldId, string>>;

export interface MediaJobFormValidationOptions {
  readonly cwd: string;
  readonly providerAvailable: boolean;
  readonly allowedRatios?: readonly string[];
  readonly allowedDurations?: readonly number[];
}

export interface MediaJobDisplayContext {
  readonly projectName?: string;
  readonly sceneName?: string;
  readonly source?: MediaJobSourceView;
}

export interface MediaJobNavigationIntents {
  readonly openApproval?: (approvalId: string) => void;
  readonly openProviderRepair?: (providerPresetId: string | undefined, operation: MediaOperation) => void;
  readonly refreshApprovals?: () => Promise<void>;
}

export interface MediaJobProjectionInput {
  readonly job: MediaJob;
  readonly result: MediaJobResultView;
  readonly source: MediaJobSourceView;
  readonly approval: MediaJobApprovalView;
  readonly isRunning: boolean;
  readonly stale: boolean;
  readonly context?: MediaJobDisplayContext;
}

export type MediaJobReusableForm = MediaJobFormState;
