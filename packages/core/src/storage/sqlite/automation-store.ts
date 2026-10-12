import { createHash } from "node:crypto";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { automationDraftToCreateRequest, validateAutomationDraft } from "../../automation-drafts.js";
import type { RunStore } from "../../run-types.js";
import {
  createAutomationDraftId,
  createAutomationId,
  createAutomationRunId,
  type AutomationDefinition,
  type AutomationDraft,
  type AutomationDraftConfirmationResult,
  type AutomationRun,
  type CreateAutomationDefinitionInput,
  type CreateAutomationDraftInput,
  type CreateAutomationRunInput,
  type ListAutomationDefinitionsOptions,
  type ListAutomationDraftsOptions,
  type ListAutomationRunsOptions,
  type UpdateAutomationDefinitionInput,
  type UpdateAutomationDraftInput,
  type UpdateAutomationRunInput,
} from "../../automation-types.js";
import {
  nullableUpdate,
  omitUndefined,
  rollbackOwnedSqliteTransaction,
  stringifyJson,
} from "./helpers.js";
import {
  mapAutomationDefinition,
  mapAutomationDraft,
  mapAutomationRun,
} from "./automation-mappers.js";
import {
  automationDefinitionSelectSql,
  automationDraftSelectSql,
  automationRunSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteAutomationStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext, private readonly ports: Pick<RunStore, "createLingThread" | "getLingThread" | "getChannel">) {
    this.context = context;
  }

  createAutomationDefinition(input: CreateAutomationDefinitionInput, now: string): AutomationDefinition {
    const definition: AutomationDefinition = {
      id: input.id ?? createAutomationId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      automationMode: input.automationMode ?? "cron",
      title: input.title,
      description: input.description,
      kind: input.kind,
      status: input.status ?? "enabled",
      trigger: input.trigger,
      rrule: input.rrule,
      cwds: input.cwds ?? [],
      targetThreadId: input.targetThreadId,
      executionEnvironment: input.executionEnvironment,
      reasoningEffort: input.reasoningEffort,
      model: input.model,
      target: input.target,
      promptTemplate: input.promptTemplate,
      executionPolicy: input.executionPolicy,
      outputPolicy: input.outputPolicy,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.nextRunAt,
    };
    this.context.database
      .prepare(`
        INSERT INTO automation_definitions (
          id,
          workspace_id,
          channel_id,
          thread_id,
          automation_mode,
          title,
          description,
          kind,
          status,
          trigger_json,
          rrule,
          cwds_json,
          target_thread_id,
          execution_environment,
          reasoning_effort,
          model,
          target_json,
          prompt_template_json,
          execution_policy_json,
          output_policy_json,
          created_at,
          updated_at,
          last_run_id,
          next_run_at,
          last_error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        definition.id,
        definition.workspaceId,
        definition.channelId ?? null,
        definition.threadId,
        definition.automationMode,
        definition.title,
        definition.description ?? null,
        definition.kind,
        definition.status,
        stringifyJson(definition.trigger),
        definition.rrule ?? null,
        stringifyJson(definition.cwds),
        definition.targetThreadId ?? null,
        definition.executionEnvironment ?? null,
        definition.reasoningEffort ?? null,
        definition.model ?? null,
        stringifyJson(definition.target),
        stringifyJson(definition.promptTemplate),
        stringifyJson(definition.executionPolicy),
        stringifyJson(definition.outputPolicy),
        definition.createdAt,
        definition.updatedAt,
        null,
        definition.nextRunAt ?? null,
        null,
      );
    const stored = this.getAutomationDefinition(definition.id);
    if (!stored) {
      throw new Error(`Failed to persist automation definition: ${definition.id}`);
    }
    return stored;
  }

  getAutomationDefinition(automationId: string): AutomationDefinition | undefined {
    const row = this.context.database.prepare(automationDefinitionSelectSql("WHERE id = ?")).get(automationId);
    return row ? mapAutomationDefinition(row) : undefined;
  }

  listAutomationDefinitions(options: ListAutomationDefinitionsOptions = {}): AutomationDefinition[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.providerPresetId) {
      clauses.push("json_extract(execution_policy_json, '$.providerPresetId') = ?");
      params.push(options.providerPresetId);
    }
    if (options.scheduledOnly) {
      clauses.push("json_extract(trigger_json, '$.type') = 'schedule'");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${automationDefinitionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationDefinition);
  }

  updateAutomationDefinition(
    automationId: string,
    input: UpdateAutomationDefinitionInput,
    now: string,
  ): AutomationDefinition | undefined {
    const existing = this.getAutomationDefinition(automationId);
    if (!existing) {
      return undefined;
    }
    const next: AutomationDefinition = {
      ...existing,
      channelId: nullableUpdate(input.channelId, existing.channelId),
      threadId: input.threadId ?? existing.threadId,
      automationMode: input.automationMode ?? existing.automationMode,
      title: input.title ?? existing.title,
      description: nullableUpdate(input.description, existing.description),
      kind: input.kind ?? existing.kind,
      status: input.status ?? existing.status,
      trigger: input.trigger ?? existing.trigger,
      rrule: nullableUpdate(input.rrule, existing.rrule),
      cwds: input.cwds ?? existing.cwds,
      targetThreadId: nullableUpdate(input.targetThreadId, existing.targetThreadId),
      executionEnvironment: nullableUpdate(input.executionEnvironment, existing.executionEnvironment),
      reasoningEffort: nullableUpdate(input.reasoningEffort, existing.reasoningEffort),
      model: nullableUpdate(input.model, existing.model),
      target: input.target ?? existing.target,
      promptTemplate: input.promptTemplate ?? existing.promptTemplate,
      executionPolicy: input.executionPolicy ?? existing.executionPolicy,
      outputPolicy: input.outputPolicy ?? existing.outputPolicy,
      updatedAt: now,
      lastRunId: nullableUpdate(input.lastRunId, existing.lastRunId),
      nextRunAt: nullableUpdate(input.nextRunAt, existing.nextRunAt),
      lastErrorMessage: nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage),
    };
    this.context.database
      .prepare(`
        UPDATE automation_definitions
        SET channel_id = ?,
            thread_id = ?,
            automation_mode = ?,
            title = ?,
            description = ?,
            kind = ?,
            status = ?,
            trigger_json = ?,
            rrule = ?,
            cwds_json = ?,
            target_thread_id = ?,
            execution_environment = ?,
            reasoning_effort = ?,
            model = ?,
            target_json = ?,
            prompt_template_json = ?,
            execution_policy_json = ?,
            output_policy_json = ?,
            updated_at = ?,
            last_run_id = ?,
            next_run_at = ?,
            last_error_message = ?
        WHERE id = ?
      `)
      .run(
        next.channelId ?? null,
        next.threadId,
        next.automationMode,
        next.title,
        next.description ?? null,
        next.kind,
        next.status,
        stringifyJson(next.trigger),
        next.rrule ?? null,
        stringifyJson(next.cwds),
        next.targetThreadId ?? null,
        next.executionEnvironment ?? null,
        next.reasoningEffort ?? null,
        next.model ?? null,
        stringifyJson(next.target),
        stringifyJson(next.promptTemplate),
        stringifyJson(next.executionPolicy),
        stringifyJson(next.outputPolicy),
        next.updatedAt,
        next.lastRunId ?? null,
        next.nextRunAt ?? null,
        next.lastErrorMessage ?? null,
        automationId,
      );
    return this.getAutomationDefinition(automationId);
  }

  archiveAutomationDefinition(automationId: string, now: string): AutomationDefinition | undefined {
    return this.updateAutomationDefinition(automationId, { status: "archived", nextRunAt: null }, now);
  }

  createAutomationDraft(input: CreateAutomationDraftInput, now: string): AutomationDraft {
    const draft = validateAutomationDraft({
      id: input.id ?? createAutomationDraftId(),
      source: input.source,
      status: input.status ?? "draft",
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId ?? input.target?.channelId,
      title: input.title,
      description: input.description,
      kind: input.kind,
      trigger: input.trigger,
      target: input.target,
      promptTemplate: input.promptTemplate,
      executionPolicy: input.executionPolicy,
      outputPolicy: input.outputPolicy,
      missingFields: [],
      warnings: [],
      createdAt: now,
      updatedAt: now,
      proposedByRunId: input.proposedByRunId,
      proposedByThreadId: input.proposedByThreadId,
    });
    this.context.database
      .prepare(`
        INSERT INTO automation_drafts (
          id,
          workspace_id,
          channel_id,
          source,
          status,
          draft_json,
          missing_fields_json,
          warnings_json,
          proposed_by_run_id,
          proposed_by_thread_id,
          confirmed_automation_id,
          discarded_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        draft.id,
        draft.workspaceId,
        draft.channelId ?? null,
        draft.source,
        draft.status,
        stringifyJson(automationDraftPayload(draft)),
        stringifyJson(draft.missingFields),
        stringifyJson(draft.warnings),
        draft.proposedByRunId ?? null,
        draft.proposedByThreadId ?? null,
        null,
        null,
        draft.createdAt,
        draft.updatedAt,
      );
    const stored = this.getAutomationDraft(draft.id);
    if (!stored) {
      throw new Error(`Failed to persist automation draft: ${draft.id}`);
    }
    return stored;
  }

  getAutomationDraft(draftId: string): AutomationDraft | undefined {
    const row = this.context.database.prepare(automationDraftSelectSql("WHERE id = ?")).get(draftId);
    return row ? mapAutomationDraft(row) : undefined;
  }

  listAutomationDrafts(options: ListAutomationDraftsOptions = {}): AutomationDraft[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeTerminal) {
      clauses.push("status NOT IN ('confirmed', 'discarded')");
    }
    if (options.source) {
      clauses.push("source = ?");
      params.push(options.source);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${automationDraftSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationDraft);
  }

  updateAutomationDraft(draftId: string, input: UpdateAutomationDraftInput, now: string): AutomationDraft | undefined {
    const existing = this.getAutomationDraft(draftId);
    if (!existing || existing.status === "confirmed" || existing.status === "discarded") {
      return existing;
    }
    const next = validateAutomationDraft({
      ...existing,
      channelId: nullableUpdate(input.channelId, existing.channelId),
      title: nullableUpdate(input.title, existing.title),
      description: nullableUpdate(input.description, existing.description),
      kind: nullableUpdate(input.kind, existing.kind),
      trigger: nullableUpdate(input.trigger, existing.trigger),
      target: nullableUpdate(input.target, existing.target),
      promptTemplate: nullableUpdate(input.promptTemplate, existing.promptTemplate),
      executionPolicy: nullableUpdate(input.executionPolicy, existing.executionPolicy),
      outputPolicy: nullableUpdate(input.outputPolicy, existing.outputPolicy),
      proposedByRunId: nullableUpdate(input.proposedByRunId, existing.proposedByRunId),
      proposedByThreadId: nullableUpdate(input.proposedByThreadId, existing.proposedByThreadId),
      updatedAt: now,
    });
    this.writeAutomationDraft(next);
    return this.getAutomationDraft(draftId);
  }

  discardAutomationDraft(draftId: string, now: string): AutomationDraft | undefined {
    const existing = this.getAutomationDraft(draftId);
    if (!existing || existing.status === "confirmed" || existing.status === "discarded") {
      return existing;
    }
    const next: AutomationDraft = {
      ...existing,
      status: "discarded",
      discardedAt: now,
      updatedAt: now,
    };
    this.writeAutomationDraft(next);
    return this.getAutomationDraft(draftId);
  }

  /** No await is permitted inside this transaction: the draft is the unique source. */
  confirmAutomationDraft(expectedDraft: AutomationDraft, now: string): AutomationDraftConfirmationResult {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.confirmAutomationDraftInTransaction(expectedDraft, now);
      this.context.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }

  private confirmAutomationDraftInTransaction(expectedDraft: AutomationDraft, now: string): AutomationDraftConfirmationResult {
    const existing = this.getAutomationDraft(expectedDraft.id);
    if (!existing) return { outcome: "not_found" };
    const sourceKey = createHash("sha256").update(existing.id).digest("hex");
    const automationId = `automation_from_draft_${sourceKey}`;
    const threadId = `thread_from_automation_draft_${sourceKey}`;
    if (existing.status === "confirmed") {
      const automation = existing.confirmedAutomationId ? this.getAutomationDefinition(existing.confirmedAutomationId) : undefined;
      const thread = automation ? this.ports.getLingThread(automation.threadId) : undefined;
      const channelId = existing.channelId ?? existing.target?.channelId;
      if (!automation || !thread || automation.id !== automationId || thread.id !== threadId
        || automation.threadId !== threadId || thread.kind !== "automation"
        || automation.workspaceId !== existing.workspaceId || thread.workspaceId !== existing.workspaceId
        || automation.channelId !== channelId || thread.channelId !== channelId) {
        return { outcome: "confirmed_state_invalid", draft: existing };
      }
      return { outcome: "already_confirmed", draft: existing, automation, thread };
    }
    if (existing.status !== "ready_for_confirmation" || existing.discardedAt || existing.confirmedAutomationId
      || existing.workspaceId !== DEFAULT_WORKSPACE_ID) {
      return { outcome: "not_ready", draft: existing };
    }
    // Millisecond timestamps alone are not a version: two edits may share one timestamp.
    if (canonicalDraftSnapshot(existing) !== canonicalDraftSnapshot(expectedDraft)) {
      return { outcome: "changed", draft: existing };
    }
    const validated = validateAutomationDraft(existing);
    if (validated.status !== "ready_for_confirmation") return { outcome: "not_ready", draft: validated };
    const input = automationDraftToCreateRequest(validated);
    const channelId = input.channelId ?? input.target.channelId;
    if (channelId && !this.ports.getChannel(channelId)) return { outcome: "not_ready", draft: existing };
    // A matching predictable ID is not proof of provenance. Never adopt a pre-existing row.
    if (this.getAutomationDefinition(automationId) || this.ports.getLingThread(threadId)) {
      return { outcome: "source_identity_conflict", draft: existing };
    }
    const thread = this.ports.createLingThread({ id: threadId, kind: "automation", channelId,
      title: input.title, objective: input.promptTemplate.promptMarkdown, status: "open" }, now);
    const automation = this.createAutomationDefinition({ ...input, id: automationId, threadId }, now);
    const updated = this.context.database.prepare(`
      UPDATE automation_drafts SET status = 'confirmed', confirmed_automation_id = ?, updated_at = ?
      WHERE id = ? AND status = 'ready_for_confirmation' AND confirmed_automation_id IS NULL AND discarded_at IS NULL
    `).run(automation.id, now, existing.id);
    if (updated.changes !== 1) throw new Error("Automation draft confirmation lost its source claim");
    const draft = this.getAutomationDraft(existing.id);
    if (!draft || draft.status !== "confirmed" || draft.confirmedAutomationId !== automation.id) {
      throw new Error("Automation draft confirmation did not persist its source claim");
    }
    return { outcome: "created", draft, automation, thread };
  }

  createAutomationRun(input: CreateAutomationRunInput, now: string): AutomationRun {
    const existing = this.findAutomationRunByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      throw new Error(`Automation run idempotency key already exists: ${input.idempotencyKey}`);
    }
    const run: AutomationRun = {
      id: input.id ?? createAutomationRunId(),
      automationId: input.automationId,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      runId: input.runId,
      triggerType: input.triggerType,
      scheduledFor: input.scheduledFor,
      firedAt: input.firedAt ?? now,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status: input.status ?? "queued",
      idempotencyKey: input.idempotencyKey,
      contextPreviewArtifactId: input.contextPreviewArtifactId,
      outputArtifactIds: input.outputArtifactIds ?? [],
      skipReason: input.skipReason,
      errorMessage: input.errorMessage,
    };
    this.context.database
      .prepare(`
        INSERT INTO automation_runs (
          id,
          automation_id,
          workspace_id,
          channel_id,
          thread_id,
          run_id,
          trigger_type,
          scheduled_for,
          fired_at,
          started_at,
          completed_at,
          status,
          idempotency_key,
          context_preview_artifact_id,
          output_artifact_ids_json,
          skip_reason,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.automationId,
        run.workspaceId,
        run.channelId ?? null,
        run.threadId,
        run.runId ?? null,
        run.triggerType,
        run.scheduledFor ?? null,
        run.firedAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.status,
        run.idempotencyKey,
        run.contextPreviewArtifactId ?? null,
        stringifyJson(run.outputArtifactIds),
        run.skipReason ?? null,
        run.errorMessage ?? null,
      );
    const stored = this.getAutomationRun(run.id);
    if (!stored) {
      throw new Error(`Failed to persist automation run: ${run.id}`);
    }
    return stored;
  }

  getAutomationRun(automationRunId: string): AutomationRun | undefined {
    const row = this.context.database.prepare(automationRunSelectSql("WHERE id = ?")).get(automationRunId);
    return row ? mapAutomationRun(row) : undefined;
  }

  findAutomationRunByIdempotencyKey(idempotencyKey: string): AutomationRun | undefined {
    const row = this.context.database.prepare(automationRunSelectSql("WHERE idempotency_key = ?")).get(idempotencyKey);
    return row ? mapAutomationRun(row) : undefined;
  }

  listAutomationRuns(options: ListAutomationRunsOptions = {}): AutomationRun[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.automationId) {
      clauses.push("automation_id = ?");
      params.push(options.automationId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${automationRunSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY fired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapAutomationRun);
  }

  updateAutomationRun(automationRunId: string, input: UpdateAutomationRunInput, now: string): AutomationRun | undefined {
    const existing = this.getAutomationRun(automationRunId);
    if (!existing) {
      return undefined;
    }
    const next: AutomationRun = {
      ...existing,
      runId: nullableUpdate(input.runId, existing.runId),
      startedAt: nullableUpdate(input.startedAt, existing.startedAt),
      completedAt: nullableUpdate(input.completedAt, existing.completedAt),
      status: input.status ?? existing.status,
      contextPreviewArtifactId: nullableUpdate(input.contextPreviewArtifactId, existing.contextPreviewArtifactId),
      outputArtifactIds: input.outputArtifactIds ?? existing.outputArtifactIds,
      skipReason: nullableUpdate(input.skipReason, existing.skipReason),
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
    };
    this.context.database
      .prepare(`
        UPDATE automation_runs
        SET run_id = ?,
            started_at = ?,
            completed_at = ?,
            status = ?,
            context_preview_artifact_id = ?,
            output_artifact_ids_json = ?,
            skip_reason = ?,
            error_message = ?
        WHERE id = ?
      `)
      .run(
        next.runId ?? null,
        next.startedAt ?? null,
        next.completedAt ?? null,
        next.status,
        next.contextPreviewArtifactId ?? null,
        stringifyJson(next.outputArtifactIds),
        next.skipReason ?? null,
        next.errorMessage ?? null,
        automationRunId,
      );
    const stored = this.getAutomationRun(automationRunId);
    if (stored) {
      this.updateAutomationDefinition(
        stored.automationId,
        {
          lastRunId: stored.id,
          lastErrorMessage: stored.status === "failed" ? stored.errorMessage ?? "Automation run failed." : null,
        },
        now,
      );
    }
    return stored;
  }

  private writeAutomationDraft(draft: AutomationDraft): void {
    this.context.database
      .prepare(`
        UPDATE automation_drafts
        SET channel_id = ?,
            status = ?,
            draft_json = ?,
            missing_fields_json = ?,
            warnings_json = ?,
            proposed_by_run_id = ?,
            proposed_by_thread_id = ?,
            confirmed_automation_id = ?,
            discarded_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status NOT IN ('confirmed', 'discarded')
          AND confirmed_automation_id IS NULL
          AND discarded_at IS NULL
      `)
      .run(
        draft.channelId ?? null,
        draft.status,
        stringifyJson(automationDraftPayload(draft)),
        stringifyJson(draft.missingFields),
        stringifyJson(draft.warnings),
        draft.proposedByRunId ?? null,
        draft.proposedByThreadId ?? null,
        draft.confirmedAutomationId ?? null,
        draft.discardedAt ?? null,
        draft.updatedAt,
        draft.id,
      );
  }
}

function automationDraftPayload(draft: AutomationDraft): Record<string, unknown> {
  return omitUndefined({
    title: draft.title,
    description: draft.description,
    kind: draft.kind,
    trigger: draft.trigger,
    target: draft.target,
    promptTemplate: draft.promptTemplate,
    executionPolicy: draft.executionPolicy,
    outputPolicy: draft.outputPolicy,
  });
}

function canonicalDraftSnapshot(draft: AutomationDraft): string {
  return JSON.stringify(draft, function (_key, value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return value;
  });
}
