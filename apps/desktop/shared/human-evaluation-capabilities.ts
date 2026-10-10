import type { RunEvaluationHumanSubmissionV1, RunEvaluationHumanHeadV1,
  RunEvaluationHumanEventV1 } from "@ling-stack/contracts";

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

/** No credentials, identity flags or arbitrary Host paths cross this capability. */
export interface DesktopHumanEvaluationCapabilities {
  submit(request: DesktopHumanEvaluationRequest): Promise<DesktopHumanEvaluationResult>;
  cancel(requestId: string): Promise<{ readonly accepted: boolean }>;
  inspect(request: DesktopHumanEvaluationInspectRequest): Promise<DesktopHumanEvaluationSnapshot>;
}
