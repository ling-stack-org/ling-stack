export type MediaGenerationKind = "image" | "video";

export type MediaGenerationTargetRef =
  | { readonly kind: "provider"; readonly providerPresetId: string }
  | { readonly kind: "workflow"; readonly workflowDefinitionId: string };

export interface WorkspaceMediaGenerationDefaults {
  readonly image?: MediaGenerationTargetRef;
  readonly video?: MediaGenerationTargetRef;
}

export interface MediaGenerationTargetView {
  readonly id: string;
  readonly ref: MediaGenerationTargetRef;
  readonly generationKind: MediaGenerationKind;
  readonly displayName: string;
  readonly runnable: boolean;
  readonly unavailableReason?: string;
}

export interface ConversationMediaGenerationTargetsResponse {
  readonly cwd: string;
  readonly defaults: WorkspaceMediaGenerationDefaults;
  readonly targets: readonly MediaGenerationTargetView[];
}
