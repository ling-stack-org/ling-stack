import type { SQLOutputValue } from "node:sqlite";
import {
  createSkillCandidateId,
  createSkillCandidateReviewRecordId,
  type ApplySkillCandidateReviewActionInput,
  type CreateSkillCandidateInput,
  type ListSkillCandidatesOptions,
  type SkillCandidate,
  type SkillCandidateDraftDefinition,
  type SkillCandidateReviewActor,
  type SkillCandidateReviewRecord,
  type SkillCandidateReviewAction,
  type SkillCandidateSourceRef,
  type SkillCandidateStatus,
} from "../../skill-candidate-types.js";
import type { SkillDuplicateAnalysis, SkillHealthFinding } from "../../skill-health.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { parseJson, readNullableString, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const skillCandidateSelectSql = `
  SELECT
    id,
    workspace_id,
    origin,
    target_skill_id,
    proposed_action,
    status,
    title,
    summary,
    definition_json,
    duplicate_analysis_json,
    safety_findings_json,
    source_refs_json,
    review_notes_json,
    expires_at,
    superseded_by,
    created_at,
    updated_at
  FROM skill_candidates
`;

const skillCandidateReviewSelectSql = `
  SELECT
    id,
    workspace_id,
    candidate_id,
    action,
    actor,
    previous_status,
    next_status,
    reason,
    created_at
  FROM skill_candidate_review_records
`;

export class SqliteSkillCandidateStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createSkillCandidate(input: CreateSkillCandidateInput, now: string): SkillCandidate {
    const candidate: SkillCandidate = {
      id: input.id ?? createSkillCandidateId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      origin: input.origin,
      targetSkillId: input.targetSkillId,
      proposedAction: input.proposedAction,
      status: input.status ?? "pending",
      title: input.title,
      summary: input.summary,
      definition: withoutLegacyCandidateWorkflowPhases(input.definition),
      duplicateAnalysis: input.duplicateAnalysis,
      safetyFindings: input.safetyFindings ?? [],
      sourceRefs: input.sourceRefs,
      reviewNotes: input.reviewNotes ?? [],
      expiresAt: input.expiresAt,
      supersededBy: input.supersededBy,
      createdAt: now,
      updatedAt: now,
    };
    validateSkillCandidate(candidate);
    this.context.database
      .prepare(`
        INSERT INTO skill_candidates (
          id,
          workspace_id,
          origin,
          target_skill_id,
          proposed_action,
          status,
          title,
          summary,
          definition_json,
          duplicate_analysis_json,
          safety_findings_json,
          source_refs_json,
          review_notes_json,
          expires_at,
          superseded_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        candidate.id,
        candidate.workspaceId,
        candidate.origin,
        candidate.targetSkillId ?? null,
        candidate.proposedAction,
        candidate.status,
        candidate.title,
        candidate.summary,
        stringifyJson(candidate.definition),
        stringifyJson(candidate.duplicateAnalysis),
        stringifyJson(candidate.safetyFindings),
        stringifyJson(candidate.sourceRefs),
        stringifyJson(candidate.reviewNotes),
        candidate.expiresAt ?? null,
        candidate.supersededBy ?? null,
        candidate.createdAt,
        candidate.updatedAt,
      );
    return candidate;
  }

  getSkillCandidate(id: string): SkillCandidate | undefined {
    const row = this.context.database
      .prepare(`${skillCandidateSelectSql} WHERE id = ?`)
      .get(id);
    return row ? mapSkillCandidate(row as Record<string, SQLOutputValue>) : undefined;
  }

  listSkillCandidates(options: ListSkillCandidatesOptions = {}): SkillCandidate[] {
    const conditions = ["workspace_id = ?"];
    const params: Array<string | number> = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options.origin) {
      conditions.push("origin = ?");
      params.push(options.origin);
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database
      .prepare(`${skillCandidateSelectSql} WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapSkillCandidate(row as Record<string, SQLOutputValue>));
  }

  listSkillCandidateReviewRecords(candidateId: string): SkillCandidateReviewRecord[] {
    return this.context.database
      .prepare(`${skillCandidateReviewSelectSql} WHERE candidate_id = ? ORDER BY created_at DESC, id DESC`)
      .all(candidateId)
      .map((row) => mapSkillCandidateReviewRecord(row as Record<string, SQLOutputValue>));
  }

  applySkillCandidateReviewAction(input: ApplySkillCandidateReviewActionInput, now: string): { readonly candidate: SkillCandidate; readonly action: SkillCandidateReviewRecord } {
    const existing = this.getSkillCandidate(input.candidateId);
    if (!existing) {
      throw new Error(`Skill candidate not found: ${input.candidateId}`);
    }
    const workspaceId = input.workspaceId ?? existing.workspaceId;
    if (workspaceId !== existing.workspaceId) {
      throw new Error("Skill candidate review workspace does not match candidate");
    }
    const nextStatus = nextSkillCandidateStatus(existing, input);
    const nextSupersededBy = input.action === "supersede" ? input.supersededBy : existing.supersededBy;
    if (nextSupersededBy === existing.id) {
      throw new Error("Skill candidate cannot supersede itself");
    }
    if (nextStatus === "approved_for_draft") {
      assertCandidatePublishEligible(existing);
    }
    const action: SkillCandidateReviewRecord = {
      id: createSkillCandidateReviewRecordId(),
      workspaceId,
      candidateId: existing.id,
      action: input.action,
      actor: input.actor,
      previousStatus: existing.status,
      nextStatus,
      reason: input.reason,
      createdAt: now,
    };
    validateSkillCandidateReviewActionRecord(action);
    this.context.database.exec("BEGIN");
    try {
      this.context.database
        .prepare(`
          UPDATE skill_candidates
          SET status = ?, superseded_by = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?
        `)
        .run(nextStatus, nextSupersededBy ?? null, now, workspaceId, existing.id);
      this.context.database
        .prepare(`
          INSERT INTO skill_candidate_review_records (
            id,
            workspace_id,
            candidate_id,
            action,
            actor,
            previous_status,
            next_status,
            reason,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          action.id,
          action.workspaceId,
          action.candidateId,
          action.action,
          action.actor,
          action.previousStatus,
          action.nextStatus,
          action.reason ?? null,
          action.createdAt,
        );
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    const updated = this.getSkillCandidate(existing.id);
    if (!updated) {
      throw new Error(`Skill candidate disappeared after review: ${existing.id}`);
    }
    return { candidate: updated, action };
  }

  markSkillCandidatePublished(candidateId: string, now: string): SkillCandidate {
    const existing = this.getSkillCandidate(candidateId);
    if (!existing) {
      throw new Error(`Skill candidate not found: ${candidateId}`);
    }
    if (existing.status === "published") {
      return existing;
    }
    if (existing.status !== "approved_for_draft") {
      throw new Error(`Skill candidate must be approved_for_draft before publish: ${existing.status}`);
    }
    this.context.database
      .prepare(`
        UPDATE skill_candidates
        SET status = 'published', updated_at = ?
        WHERE workspace_id = ? AND id = ?
      `)
      .run(now, existing.workspaceId, existing.id);
    const updated = this.getSkillCandidate(existing.id);
    if (!updated) {
      throw new Error(`Skill candidate disappeared after publish: ${existing.id}`);
    }
    return updated;
  }
}

function mapSkillCandidate(row: Record<string, SQLOutputValue>): SkillCandidate {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    origin: readString(row, "origin") as SkillCandidate["origin"],
    targetSkillId: readNullableString(row, "target_skill_id"),
    proposedAction: readString(row, "proposed_action") as SkillCandidate["proposedAction"],
    status: readString(row, "status") as SkillCandidateStatus,
    title: readString(row, "title"),
    summary: readString(row, "summary"),
    definition: parseSkillCandidateDraftDefinition(readString(row, "definition_json")),
    duplicateAnalysis: parseDuplicateAnalysis(readString(row, "duplicate_analysis_json")),
    safetyFindings: parseSafetyFindings(readString(row, "safety_findings_json")),
    sourceRefs: parseSourceRefs(readString(row, "source_refs_json")),
    reviewNotes: parseStringArray(readString(row, "review_notes_json")),
    expiresAt: readNullableString(row, "expires_at"),
    supersededBy: readNullableString(row, "superseded_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapSkillCandidateReviewRecord(row: Record<string, SQLOutputValue>): SkillCandidateReviewRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    candidateId: readString(row, "candidate_id"),
    action: readString(row, "action") as SkillCandidateReviewAction,
    actor: readString(row, "actor") as SkillCandidateReviewActor,
    previousStatus: readString(row, "previous_status") as SkillCandidateStatus,
    nextStatus: readString(row, "next_status") as SkillCandidateStatus,
    reason: readNullableString(row, "reason"),
    createdAt: readString(row, "created_at"),
  };
}

function parseSkillCandidateDraftDefinition(value: string): SkillCandidateDraftDefinition {
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) {
    throw new Error("Expected skill candidate definition object from SQLite");
  }
  return {
    positiveTriggers: readRecordStringArray(parsed, "positiveTriggers"),
    negativeTriggers: readRecordStringArray(parsed, "negativeTriggers"),
    procedureSteps: readRecordArray(parsed, "procedureSteps").map(parseProcedureStep),
    validationSteps: readRecordArray(parsed, "validationSteps").map(parseValidationStep),
    requiredTools: readRecordStringArray(parsed, "requiredTools"),
    requiredProviderCapabilities: readRecordStringArray(parsed, "requiredProviderCapabilities"),
    ...(isPlainRecord(parsed.skillDefinition)
      ? { skillDefinition: withoutLegacySkillWorkflowPhase(parsed.skillDefinition) }
      : {}),
  };
}

function withoutLegacySkillWorkflowPhase(
  value: Record<string, unknown>,
): NonNullable<SkillCandidateDraftDefinition["skillDefinition"]> {
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value;
  return definition as unknown as NonNullable<SkillCandidateDraftDefinition["skillDefinition"]>;
}

function withoutLegacyCandidateWorkflowPhases(
  value: SkillCandidateDraftDefinition,
): SkillCandidateDraftDefinition {
  const { workflowPhase: _legacyWorkflowPhase, ...definition } = value as SkillCandidateDraftDefinition & { readonly workflowPhase?: unknown };
  return definition.skillDefinition
    ? { ...definition, skillDefinition: withoutLegacySkillWorkflowPhase(definition.skillDefinition as unknown as Record<string, unknown>) }
    : definition;
}

function parseProcedureStep(value: unknown): SkillCandidateDraftDefinition["procedureSteps"][number] {
  if (!isPlainRecord(value)) {
    throw new Error("Expected skill candidate procedure step object");
  }
  return {
    title: readRecordString(value, "title"),
    ...(typeof value.instruction === "string" ? { instruction: value.instruction } : {}),
    ...(Array.isArray(value.requiredTools) ? { requiredTools: value.requiredTools.map(String) } : {}),
  };
}

function parseValidationStep(value: unknown): SkillCandidateDraftDefinition["validationSteps"][number] {
  if (!isPlainRecord(value)) {
    throw new Error("Expected skill candidate validation step object");
  }
  return {
    title: readRecordString(value, "title"),
    ...(typeof value.commandOrCheck === "string" ? { commandOrCheck: value.commandOrCheck } : {}),
    ...(typeof value.expectedResult === "string" ? { expectedResult: value.expectedResult } : {}),
  };
}

function parseDuplicateAnalysis(value: string): SkillDuplicateAnalysis {
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) {
    throw new Error("Expected skill duplicate analysis object from SQLite");
  }
  return parsed as unknown as SkillDuplicateAnalysis;
}

function parseSafetyFindings(value: string): readonly SkillHealthFinding[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected skill safety findings array from SQLite");
  }
  return parsed as unknown as readonly SkillHealthFinding[];
}

function parseSourceRefs(value: string): readonly SkillCandidateSourceRef[] {
  return parseJsonArray(value).map((item) => {
    if (!isPlainRecord(item)) {
      throw new Error("Expected skill candidate source ref object from SQLite");
    }
    return {
      type: readRecordString(item, "type") as SkillCandidateSourceRef["type"],
      id: readRecordString(item, "id"),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    };
  });
}

function parseStringArray(value: string): readonly string[] {
  return parseJsonArray(value).map(String);
}

function parseJsonArray(value: string): readonly unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from SQLite");
  }
  return parsed;
}

function validateSkillCandidate(candidate: SkillCandidate): void {
  if (!candidate.id || !candidate.title.trim() || !candidate.summary.trim()) {
    throw new Error("Skill candidate id, title, and summary are required");
  }
  if (!isSupportedStatus(candidate.status)) {
    throw new Error("Skill candidate status is not supported");
  }
  if (!isSupportedOrigin(candidate.origin)) {
    throw new Error("Skill candidate origin is not supported");
  }
  if (!isSupportedProposedAction(candidate.proposedAction)) {
    throw new Error("Skill candidate proposed action is not supported");
  }
  if (candidate.sourceRefs.length === 0) {
    throw new Error("Skill candidate requires at least one source ref");
  }
  if (candidate.definition.positiveTriggers.length === 0) {
    throw new Error("Skill candidate requires at least one positive trigger");
  }
  if (candidate.supersededBy === candidate.id) {
    throw new Error("Skill candidate cannot supersede itself");
  }
}

function validateSkillCandidateReviewActionRecord(action: SkillCandidateReviewRecord): void {
  if (!isSupportedReviewAction(action.action)) {
    throw new Error("Skill candidate review action is not supported");
  }
  if (action.actor !== "user" && action.actor !== "system") {
    throw new Error("Skill candidate review actor is not supported");
  }
  if (!isSupportedStatus(action.previousStatus) || !isSupportedStatus(action.nextStatus)) {
    throw new Error("Skill candidate review status is not supported");
  }
}

function nextSkillCandidateStatus(candidate: SkillCandidate, input: ApplySkillCandidateReviewActionInput): SkillCandidateStatus {
  if (candidate.status === "published" || candidate.status === "rejected" || candidate.status === "quarantined" || candidate.status === "superseded" || candidate.status === "expired") {
    throw new Error(`Cannot review terminal skill candidate: ${candidate.status}`);
  }
  switch (input.action) {
    case "keep_pending":
      return "pending";
    case "request_changes":
      return "needs_edit";
    case "approve_for_draft":
      return "approved_for_draft";
    case "reject":
      return "rejected";
    case "quarantine":
      return "quarantined";
    case "supersede":
      if (!input.supersededBy) {
        throw new Error("Supersede review action requires supersededBy");
      }
      return "superseded";
  }
}

function assertCandidatePublishEligible(candidate: SkillCandidate): void {
  if (candidate.definition.negativeTriggers.length === 0) {
    throw new Error("Skill candidate requires negative triggers before draft approval");
  }
  if (candidate.definition.validationSteps.length === 0) {
    throw new Error("Skill candidate requires validation steps before draft approval");
  }
  if (candidate.safetyFindings.some((finding) => finding.severity === "critical")) {
    throw new Error("Skill candidate has critical safety findings and cannot be approved for draft");
  }
}

function isSupportedStatus(status: string): status is SkillCandidateStatus {
  return status === "pending" ||
    status === "needs_edit" ||
    status === "approved_for_draft" ||
    status === "published" ||
    status === "rejected" ||
    status === "quarantined" ||
    status === "superseded" ||
    status === "expired";
}

function isSupportedOrigin(origin: string): boolean {
  return origin === "ling-generated" || origin === "recording" || origin === "manual-draft" || origin === "import-overlay";
}

function isSupportedProposedAction(action: string): boolean {
  return action === "create" || action === "update_existing" || action === "wrap_external" || action === "supersede";
}

function isSupportedReviewAction(action: string): action is SkillCandidateReviewAction {
  return action === "keep_pending" ||
    action === "request_changes" ||
    action === "approve_for_draft" ||
    action === "reject" ||
    action === "quarantine" ||
    action === "supersede";
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function readRecordStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Expected ${key} to be a string array`);
  }
  return value;
}

function readRecordArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an array`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
