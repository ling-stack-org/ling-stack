import type { RunEvaluationHumanSubmissionV1, RunEvaluationHumanHeadV1,
  RunEvaluationHumanEventV1, RunEvaluationHumanQaRowV1, RunEvaluationHumanReportV1 } from "@ling-stack/contracts";

export interface DesktopHumanEvaluationRequest {
  readonly taskId: string;
  readonly requestId: string;
  readonly submission: RunEvaluationHumanSubmissionV1;
}
export type DesktopHumanEvaluationResult =
  | { readonly accepted: true; readonly eventId: string; readonly revision: number; readonly state: "active" | "revoked" }
  | { readonly accepted: false; readonly reason: "invalid_request" | "unauthorized_sender" | "busy" | "cancelled"
      | "native_unavailable" | "confirmation_failed" | "authority_changed" | "host_rejected" | "submission_unknown" };

export interface DesktopHumanEvaluationReportRef {
  readonly taskId: string;
  readonly eventId: string;
  readonly revision: number;
}
export interface DesktopHumanEvaluationInspectRequest {
  readonly taskId: string;
  readonly afterRevision?: number;
  readonly reportRef?: DesktopHumanEvaluationReportRef;
}
export type DesktopHumanEvaluationSnapshot = {
  readonly accepted: true;
  readonly taskId: string;
  readonly head?: RunEvaluationHumanHeadV1;
  readonly headEvent?: RunEvaluationHumanEventV1;
  readonly events: readonly RunEvaluationHumanEventV1[];
  readonly nextAfterRevision?: number;
  readonly lastSubmission: "none" | "pending" | "committed" | "unknown";
  readonly reportCurrentness?: "current" | "stale" | "unavailable";
} | Extract<DesktopHumanEvaluationResult, { accepted: false }>;

export interface DesktopHumanEvaluationListRequest {
  readonly afterEnrollmentId?: string;
  readonly limit?: number;
}
export type DesktopHumanEvaluationListResult = {
  readonly accepted: true;
  /** Main-owned configured alias, verified to still resolve to this canonical Host scope. */
  readonly workspaceCwd: string;
  /** Fixed Host composition, not a caller-selected workspace. */
  readonly canonicalWorkspaceCwd: string;
  readonly items: readonly RunEvaluationHumanQaRowV1[];
  readonly nextAfterEnrollmentId?: string;
} | Extract<DesktopHumanEvaluationResult, { accepted: false }>;
export type DesktopHumanEvaluationReportResult = {
  readonly accepted: true;
  readonly workspaceCwd: string;
  readonly canonicalWorkspaceCwd: string;
  readonly report: RunEvaluationHumanReportV1;
  readonly currentness: "current" | "stale";
  readonly head: Pick<RunEvaluationHumanHeadV1, "eventId" | "revision" | "state">;
} | Extract<DesktopHumanEvaluationResult, { accepted: false }>;

/** No credentials, identity flags or arbitrary Host paths cross this capability. */
export interface DesktopHumanEvaluationCapabilities {
  submit(request: DesktopHumanEvaluationRequest): Promise<DesktopHumanEvaluationResult>;
  cancel(requestId: string): Promise<{ readonly accepted: boolean }>;
  inspect(request: DesktopHumanEvaluationInspectRequest): Promise<DesktopHumanEvaluationSnapshot>;
  list(request: DesktopHumanEvaluationListRequest): Promise<DesktopHumanEvaluationListResult>;
  generateReport(request: DesktopHumanEvaluationReportRef): Promise<DesktopHumanEvaluationReportResult>;
}
