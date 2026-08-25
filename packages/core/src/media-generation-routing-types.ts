import type { MediaJob, MediaOperation } from "./media-types.js";
import type { WorkUnit } from "./runtime-supervisor-types.js";

export type MediaGenerationKind = "image" | "video";
export type ConversationMediaOperation = Extract<MediaOperation, "image_generate" | "video_generate">;

export type MediaGenerationTargetRef =
  | { readonly kind: "provider"; readonly providerPresetId: string }
  | { readonly kind: "workflow"; readonly workflowDefinitionId: string };

export interface WorkspaceMediaGenerationDefaults {
  readonly image?: MediaGenerationTargetRef;
  readonly video?: MediaGenerationTargetRef;
}

export interface MediaGenerationTargetSummary {
  readonly id: string;
  readonly ref: MediaGenerationTargetRef;
  readonly generationKind: MediaGenerationKind;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly runnable: boolean;
  readonly unavailableReason?: string;
  readonly aspectRatios?: readonly string[];
  readonly sizeByAspectRatio?: Readonly<Record<string, string>>;
  readonly durationsSeconds?: readonly number[];
  readonly supportsAspectRatio?: boolean;
  readonly supportsDurationSeconds?: boolean;
  readonly supportsCount?: boolean;
}

export type MediaGenerationTargetResolutionErrorCode =
  | "generation_target_unavailable"
  | "target_selection_required"
  | "generation_target_ambiguous"
  | "generation_target_not_found"
  | "generation_target_not_runnable";

export type MediaGenerationTargetResolution =
  | {
      readonly ok: true;
      readonly target: MediaGenerationTargetSummary;
      readonly source: "explicit" | "workspace_default" | "only_runnable";
    }
  | {
      readonly ok: false;
      readonly code: MediaGenerationTargetResolutionErrorCode;
      readonly message: string;
      readonly candidates: readonly MediaGenerationTargetSummary[];
    };

export interface ConversationMediaTargetSnapshot {
  readonly id: string;
  readonly ref: MediaGenerationTargetRef;
  readonly generationKind: MediaGenerationKind;
  readonly displayName: string;
}

export interface CreateOrReuseConversationMediaJobInput {
  readonly runId: string;
  readonly linkedMessageId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly target: ConversationMediaTargetSnapshot;
  readonly mediaJob: {
    readonly providerPresetId?: string;
    readonly workflowVersionId?: string;
    readonly operation: ConversationMediaOperation;
    readonly prompt: string;
    readonly input?: Record<string, unknown>;
  };
}

export interface CreateOrReuseConversationMediaJobResult {
  readonly mediaJob: MediaJob;
  readonly workUnit: WorkUnit;
  readonly reused: boolean;
}

export function mediaGenerationKindForOperation(operation: ConversationMediaOperation): MediaGenerationKind {
  return operation === "image_generate" ? "image" : "video";
}

export function mediaGenerationTargetRefKey(ref: MediaGenerationTargetRef): string {
  return ref.kind === "provider"
    ? `provider:${ref.providerPresetId}`
    : `workflow:${ref.workflowDefinitionId}`;
}
