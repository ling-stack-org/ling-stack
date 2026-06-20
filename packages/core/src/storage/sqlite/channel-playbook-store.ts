import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
  channelPlaybookCandidateCreatedByValues,
  channelPlaybookCandidateStatuses,
  createChannelPlaybookCandidateId,
  type ChannelPlaybookCandidate,
  type ChannelPlaybookCandidateStatus,
  type CreateChannelPlaybookCandidateInput,
  type UpdateChannelPlaybookCandidateInput,
} from "../../workspace-types.js";
import type { ProcedureObservationStep, ProcedureObservationValidationStep } from "../../procedure-observation-types.js";
import type { SkillCandidateSourceRef } from "../../skill-candidate-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapChannelPlaybookCandidate } from "./channel-playbook-mappers.js";
import { channelPlaybookCandidateSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelPlaybookStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
}

export class SqliteChannelPlaybookStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelPlaybookStorePorts,
  ) {}

  createChannelPlaybookCandidate(input: CreateChannelPlaybookCandidateInput, now: string): ChannelPlaybookCandidate {
    this.ports.assertChannelExists(input.channelId);
    validateCreateChannelPlaybookCandidateInput(input);
    const candidate: ChannelPlaybookCandidate = {
      id: createChannelPlaybookCandidateId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      title: input.title,
      summary: input.summary,
      normalizedGoal: input.normalizedGoal,
      procedureSteps: input.procedureSteps,
      validationSteps: input.validationSteps ?? [],
      positiveTriggers: input.positiveTriggers ?? [],
      negativeTriggers: input.negativeTriggers ?? [],
      sourceRefs: input.sourceRefs ?? [],
      reason: input.reason,
      createdBy: input.createdBy,
      status: "draft",
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.context.database
      .prepare(`
        INSERT INTO channel_playbook_candidates (
          id,
          workspace_id,
          channel_id,
          title,
          summary,
          normalized_goal,
          procedure_steps_json,
          validation_steps_json,
          positive_triggers_json,
          negative_triggers_json,
          source_refs_json,
          reason,
          created_by,
          status,
          activated_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        candidate.id,
        candidate.workspaceId,
        candidate.channelId,
        candidate.title,
        candidate.summary,
        candidate.normalizedGoal,
        stringifyJson(candidate.procedureSteps),
        stringifyJson(candidate.validationSteps),
        stringifyJson(candidate.positiveTriggers),
        stringifyJson(candidate.negativeTriggers),
        stringifyJson(candidate.sourceRefs),
        candidate.reason,
        candidate.createdBy,
        candidate.status,
        candidate.activatedAt ?? null,
        candidate.expiresAt ?? null,
        candidate.createdAt,
        candidate.updatedAt,
      );
    const saved = this.getChannelPlaybookCandidate(candidate.id);
    if (!saved) {
      throw new Error(`Failed to create channel playbook candidate: ${candidate.id}`);
    }
    return saved;
  }

  getChannelPlaybookCandidate(id: string): ChannelPlaybookCandidate | undefined {
    const row = this.context.database.prepare(channelPlaybookCandidateSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelPlaybookCandidate(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelPlaybookCandidates(options: {
    readonly channelId: string;
    readonly status?: ChannelPlaybookCandidateStatus;
    readonly limit?: number;
  }): ChannelPlaybookCandidate[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    params.push(limit);
    return this.context.database
      .prepare(`${channelPlaybookCandidateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelPlaybookCandidate(row as Record<string, SQLOutputValue>));
  }

  updateChannelPlaybookCandidate(
    id: string,
    input: UpdateChannelPlaybookCandidateInput,
    now: string,
  ): ChannelPlaybookCandidate | undefined {
    const existing = this.getChannelPlaybookCandidate(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelPlaybookCandidate = {
      ...existing,
      status: input.status ?? existing.status,
      activatedAt: nullableUpdate(input.activatedAt, existing.activatedAt),
      updatedAt: now,
    };
    if (!channelPlaybookCandidateStatuses.includes(next.status)) {
      throw new Error("channel playbook candidate status is not supported");
    }
    this.context.database
      .prepare(`
        UPDATE channel_playbook_candidates
        SET status = ?, activated_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.status, next.activatedAt ?? null, next.updatedAt, id);
    return this.getChannelPlaybookCandidate(id);
  }
}

function validateCreateChannelPlaybookCandidateInput(input: CreateChannelPlaybookCandidateInput): void {
  validateNonEmptyString(input.title, "channel playbook candidate title");
  validateNonEmptyString(input.summary, "channel playbook candidate summary");
  validateNonEmptyString(input.normalizedGoal, "channel playbook candidate normalized goal");
  validateNonEmptyString(input.reason, "channel playbook candidate reason");
  if (!channelPlaybookCandidateCreatedByValues.includes(input.createdBy)) {
    throw new Error("channel playbook candidate createdBy is not supported");
  }
  if (input.procedureSteps.length === 0) {
    throw new Error("channel playbook candidate must include at least one procedure step");
  }
  validateProcedureSteps(input.procedureSteps);
  validateValidationSteps(input.validationSteps ?? []);
  validateStringList(input.positiveTriggers ?? [], "channel playbook positive triggers");
  validateStringList(input.negativeTriggers ?? [], "channel playbook negative triggers");
  validateSourceRefs(input.sourceRefs ?? []);
}

function validateProcedureSteps(steps: readonly ProcedureObservationStep[]): void {
  for (const step of steps) {
    validateNonEmptyString(step.title, "channel playbook procedure step title");
    if (step.instruction !== undefined) {
      validateNonEmptyString(step.instruction, "channel playbook procedure step instruction");
    }
    validateStringList(step.requiredTools ?? [], "channel playbook procedure step required tools");
    if (step.expectedEvidence !== undefined) {
      validateNonEmptyString(step.expectedEvidence, "channel playbook procedure step evidence");
    }
  }
}

function validateValidationSteps(steps: readonly ProcedureObservationValidationStep[]): void {
  for (const step of steps) {
    validateNonEmptyString(step.title, "channel playbook validation step title");
    if (step.commandOrCheck !== undefined) {
      validateNonEmptyString(step.commandOrCheck, "channel playbook validation check");
    }
    if (step.expectedResult !== undefined) {
      validateNonEmptyString(step.expectedResult, "channel playbook validation expected result");
    }
  }
}

function validateSourceRefs(sourceRefs: readonly SkillCandidateSourceRef[]): void {
  for (const sourceRef of sourceRefs) {
    validateNonEmptyString(sourceRef.type, "channel playbook source ref type");
    validateNonEmptyString(sourceRef.id, "channel playbook source ref id");
  }
}

function validateStringList(value: readonly string[], label: string): void {
  for (const item of value) {
    validateNonEmptyString(item, label);
  }
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}
