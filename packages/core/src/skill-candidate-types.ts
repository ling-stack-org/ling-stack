import { randomUUID } from "node:crypto";
import type { RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";
import type { SkillDefinition } from "./skill-types.js";
import type {
  SkillDuplicateAnalysis,
  SkillHealthFinding,
  SkillCandidateHealthOrigin,
  SkillCandidateHealthStatus,
} from "./skill-health.js";

export type SkillCandidateOrigin = SkillCandidateHealthOrigin;
export type SkillCandidateStatus = SkillCandidateHealthStatus;

export type SkillCandidateProposedAction =
  | "create"
  | "update_existing"
  | "wrap_external"
  | "supersede";

export type SkillCandidateReviewAction =
  | "keep_pending"
  | "request_changes"
  | "approve_for_draft"
  | "reject"
  | "quarantine"
  | "supersede";

export type SkillCandidateReviewActor = "user" | "system";

export type SkillCandidateSourceRefType =
  | "skill"
  | "manual"
  | "message"
  | "decision"
  | "run"
  | "run-event"
  | "artifact"
  | "import"
  | "observation-job";

export interface SkillCandidateSourceRef {
  readonly type: SkillCandidateSourceRefType;
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

export interface SkillCandidateProcedureStep {
  readonly title: string;
  readonly instruction?: string;
  readonly requiredTools?: readonly string[];
}

export interface SkillCandidateValidationStep {
  readonly title: string;
  readonly commandOrCheck?: string;
  readonly expectedResult?: string;
}

export interface SkillCandidateDraftDefinition {
  readonly positiveTriggers: readonly string[];
  readonly negativeTriggers: readonly string[];
  readonly procedureSteps: readonly SkillCandidateProcedureStep[];
  readonly validationSteps: readonly SkillCandidateValidationStep[];
  readonly requiredTools: readonly (RunTool | string)[];
  readonly requiredProviderCapabilities: readonly (ProviderCapability | string)[];
  readonly skillDefinition?: SkillDefinition;
}

export interface SkillCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly origin: SkillCandidateOrigin;
  readonly targetSkillId?: string;
  readonly proposedAction: SkillCandidateProposedAction;
  readonly status: SkillCandidateStatus;
  readonly title: string;
  readonly summary: string;
  readonly definition: SkillCandidateDraftDefinition;
  readonly duplicateAnalysis: SkillDuplicateAnalysis;
  readonly safetyFindings: readonly SkillHealthFinding[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reviewNotes: readonly string[];
  readonly expiresAt?: string;
  readonly supersededBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSkillCandidateInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly origin: SkillCandidateOrigin;
  readonly targetSkillId?: string;
  readonly proposedAction: SkillCandidateProposedAction;
  readonly status?: SkillCandidateStatus;
  readonly title: string;
  readonly summary: string;
  readonly definition: SkillCandidateDraftDefinition;
  readonly duplicateAnalysis: SkillDuplicateAnalysis;
  readonly safetyFindings?: readonly SkillHealthFinding[];
  readonly sourceRefs: readonly SkillCandidateSourceRef[];
  readonly reviewNotes?: readonly string[];
  readonly expiresAt?: string;
  readonly supersededBy?: string;
}

export interface ListSkillCandidatesOptions {
  readonly workspaceId?: string;
  readonly status?: SkillCandidateStatus;
  readonly origin?: SkillCandidateOrigin;
  readonly limit?: number;
}

export interface ApplySkillCandidateReviewActionInput {
  readonly candidateId: string;
  readonly workspaceId?: string;
  readonly action: SkillCandidateReviewAction;
  readonly actor: SkillCandidateReviewActor;
  readonly reason?: string;
  readonly supersededBy?: string;
}

export interface SkillCandidateReviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly action: SkillCandidateReviewAction;
  readonly actor: SkillCandidateReviewActor;
  readonly previousStatus: SkillCandidateStatus;
  readonly nextStatus: SkillCandidateStatus;
  readonly reason?: string;
  readonly createdAt: string;
}

export function createSkillCandidateId(): string {
  return `skill_candidate_${randomUUID()}`;
}

export function createSkillCandidateReviewRecordId(): string {
  return `skill_candidate_review_${randomUUID()}`;
}
