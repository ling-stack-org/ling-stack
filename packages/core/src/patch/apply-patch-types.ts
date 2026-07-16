export const APPLY_PATCH_FORMAT = "ling-apply-patch-v1" as const;

export type ApplyPatchFormat = typeof APPLY_PATCH_FORMAT;
export type PatchOperationKind = "add" | "update" | "delete";
export type PatchLineKind = "context" | "add" | "remove";
export type PatchLineEnding = "\n" | "\r\n" | "\r";

export interface PatchTextFormat {
  readonly lineEnding: PatchLineEnding;
  readonly trailingNewline: boolean;
}

export interface PatchLine {
  readonly kind: PatchLineKind;
  readonly text: string;
}

export interface PatchHunk {
  readonly oldStart?: number;
  readonly oldLines?: number;
  readonly newStart?: number;
  readonly newLines?: number;
  readonly lines: readonly PatchLine[];
}

export interface PatchOperation {
  readonly kind: PatchOperationKind;
  readonly path: string;
  readonly hunks: readonly PatchHunk[];
  readonly oldSha256?: string;
  readonly newSha256?: string;
  readonly oldTextFormat?: PatchTextFormat;
  readonly newTextFormat?: PatchTextFormat;
}

export interface PatchSummary {
  readonly fileCount: number;
  readonly addCount: number;
  readonly updateCount: number;
  readonly deleteCount: number;
  readonly moveCount: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface PatchPlan {
  readonly format: ApplyPatchFormat;
  readonly operations: readonly PatchOperation[];
  readonly touchedPaths: readonly string[];
  readonly summary: PatchSummary;
  readonly rawPatchSha256: string;
}

export interface ParsedApplyPatch {
  readonly operations: readonly PatchOperation[];
}

export interface ApplyPatchErrorContext {
  readonly line?: number;
  readonly directive?: string;
  readonly path?: string;
}

export class ApplyPatchError extends Error {
  readonly context: ApplyPatchErrorContext;

  constructor(message: string, context: ApplyPatchErrorContext = {}) {
    super(message);
    this.name = "ApplyPatchError";
    this.context = context;
  }
}

export interface PlanApplyPatchInput {
  readonly patchText: string;
  readonly readFile: (path: string) => string | undefined;
}

export interface ApplyPatchPlanInput {
  readonly plan: PatchPlan;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, content: string) => void | Promise<void>;
  readonly deleteFile: (path: string) => void | Promise<void>;
}

export interface AppliedPatchOperation {
  readonly kind: PatchOperationKind;
  readonly path: string;
  readonly oldSha256?: string;
  readonly newSha256?: string;
}

export interface ApplyPatchPlanResult {
  readonly status: "applied";
  readonly touchedPaths: readonly string[];
  readonly operations: readonly AppliedPatchOperation[];
}
