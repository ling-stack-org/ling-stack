import type { RunEvaluationHumanHostBindingV1, RunEvaluationHumanSubmissionV1, RunEvaluationHumanConfirmationV1,
  RunEvaluationHumanIntentV1, RunEvaluationHumanHeadV1, RunEvaluationHumanEventV1 } from "@ling-stack/contracts";
import type { ControlPlaneEvent } from "../run-types.js";
export interface CreateRunEvaluationHumanIntentInput {
  readonly taskId: string;
  readonly requestId: string;
  readonly submission: RunEvaluationHumanSubmissionV1;
  readonly binding: RunEvaluationHumanHostBindingV1;
  readonly expiresAt: string;
  readonly now: string;
}
export interface CommitRunEvaluationHumanIntentInput {
  readonly intentId: string;
  readonly payloadDigest: string;
  readonly binding: RunEvaluationHumanHostBindingV1;
  readonly confirmation: RunEvaluationHumanConfirmationV1;
  readonly now: string;
  /** Private Host generation fence, checked inside the transaction immediately before COMMIT. Never a wire DTO. */
  readonly assertAuthorityCurrent: () => void;
}
export interface ListRunEvaluationHumanEventsInput {
  readonly taskId: string;
  readonly afterRevision?: number;
  readonly limit?: number;
}
export type RunEvaluationHumanMutationCode = "not_found" | "identity_conflict" | "qa_not_enrolled"
  | "evaluation.lineage_invalid" | "evaluation.artifact_invalid" | "human_rubric_invalid"
  | "human_intent_expired" | "human_binding_changed" | "human_head_changed"
  | "human_invalid_transition" | "human_confirmation_invalid";
export type RunEvaluationHumanMutationResult<T> = { readonly ok: true; readonly value: T; readonly replayed: boolean }
  | { readonly ok: false; readonly code: RunEvaluationHumanMutationCode };
export interface RunEvaluationHumanSettlement {
  readonly intent: RunEvaluationHumanIntentV1;
  readonly head: RunEvaluationHumanHeadV1;
  readonly event: RunEvaluationHumanEventV1;
  readonly audit: ControlPlaneEvent;
}
/** Trusted local Host port only; no API authenticates a caller by DTO boolean or teammate identity. */
export interface RunEvaluationHumanStore {
  getRunEvaluationHumanIntent(intentId: string): RunEvaluationHumanIntentV1 | undefined;
  getRunEvaluationHumanHead(taskId: string): RunEvaluationHumanHeadV1 | undefined;
  getRunEvaluationHumanEvent(eventId: string): RunEvaluationHumanEventV1 | undefined;
  listRunEvaluationHumanEvents(input: ListRunEvaluationHumanEventsInput): readonly RunEvaluationHumanEventV1[];
  createRunEvaluationHumanIntent(input: CreateRunEvaluationHumanIntentInput): RunEvaluationHumanMutationResult<RunEvaluationHumanIntentV1>;
  commitRunEvaluationHumanIntent(input: CommitRunEvaluationHumanIntentInput): RunEvaluationHumanMutationResult<RunEvaluationHumanSettlement>;
}
