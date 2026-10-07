import type { SQLOutputValue } from "node:sqlite";
import {
  createLingTurnId,
  type CreateLingTurnInput,
  type LingThread,
  type LingTurn,
  type LingTurnRun,
  type LingTurnRunRole,
  type LingTurnStatus,
  type LinkRunToLingTurnInput,
  type ListLingTurnsOptions,
  type RunSession,
  type TransitionLingTurnStatusInput,
} from "../../run-types.js";
import type { CreateStateTransitionEventInput, StateTransitionEvent } from "../../channel-runtime-types.js";
import { transitionLingTurn, type TransitionResult } from "../../state-machines.js";
import { redactSecrets } from "../../redaction.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readNumber } from "./helpers.js";
import { mapLingTurn, mapLingTurnRun, runStatusToLingTurnStatus } from "./run-mappers.js";
import { lingTurnSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { UserInputWait } from "../../user-input-wait-types.js";
import { projectTurnUserInputWait } from "./user-input-wait-projection.js";

export interface SqliteLingTurnStorePorts {
  readonly getUserInputWait: (threadId: string, requestId: string) => UserInputWait | undefined;
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly rebuildLingThreadMetadata: (threadId: string | undefined, now: string) => void;
  readonly rebuildLingThreadMetadataForTurn: (turnId: string | undefined, now: string) => void;
  readonly findStateTransitionByIdempotency: (
    entityType: "turn",
    entityId: string,
    idempotencyKey: string,
  ) => StateTransitionEvent | undefined;
  readonly recordStateTransitionEvent: (input: CreateStateTransitionEventInput) => StateTransitionEvent;
}

export class SqliteLingTurnStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingTurnStorePorts,
  ) {}

  createLingTurn(input: CreateLingTurnInput, now: string): LingTurn {
    const thread = this.ports.getLingThread(input.threadId);
    if (!thread) {
      throw new Error(`Ling thread not found: ${input.threadId}`);
    }
    if (thread.status === "archived") {
      throw new Error(`Ling thread is archived: ${input.threadId}`);
    }
    if (input.sourceTurnId) {
      const sourceTurn = this.getLingTurn(input.sourceTurnId);
      if (!sourceTurn) {
        throw new Error(`Source Ling turn not found: ${input.sourceTurnId}`);
      }
      if (sourceTurn.threadId !== input.threadId) {
        throw new Error(`Source Ling turn does not belong to thread: ${input.sourceTurnId}`);
      }
    }
    if (input.activeRunId) {
      this.assertLingTurnRunReference(input.activeRunId, input.threadId, "activeRunId");
    }
    if (input.lastRunId) {
      this.assertLingTurnRunReference(input.lastRunId, input.threadId, "lastRunId");
    }

    const id = input.id ?? createLingTurnId();
    this.context.database
      .prepare(`
        INSERT INTO ling_turns (
          id,
          workspace_id,
          thread_id,
          kind,
          status,
          title,
          user_instruction,
          channel_id,
          task_id,
          teammate_id,
          workflow_step_id,
          external_work_id,
          automation_id,
          source_item_id,
          source_turn_id,
          intervention_id,
          active_run_id,
          last_run_id,
          created_by_actor,
          created_at,
          updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        DEFAULT_WORKSPACE_ID,
        input.threadId,
        input.kind,
        input.status ?? "open",
        String(redactSecrets(input.title)),
        String(redactSecrets(input.userInstruction)),
        input.channelId ?? thread.channelId ?? null,
        input.taskId ?? thread.taskId ?? null,
        input.teammateId ?? thread.teammateId ?? null,
        input.workflowStepId ?? thread.workflowStepId ?? null,
        input.externalWorkId ?? thread.externalWorkId ?? null,
        input.automationId ?? null,
        input.sourceItemId ?? null,
        input.sourceTurnId ?? null,
        input.interventionId ?? null,
        input.activeRunId ?? null,
        input.lastRunId ?? null,
        input.createdByActor ?? "local-user",
        now,
        now,
        null,
      );
    const turn = this.getLingTurn(id);
    if (!turn) {
      throw new Error(`Failed to create Ling turn: ${id}`);
    }
    this.ports.rebuildLingThreadMetadata(input.threadId, now);
    return turn;
  }

  getLingTurn(turnId: string): LingTurn | undefined {
    const row = this.context.database.prepare(lingTurnSelectSql("WHERE id = ?")).get(turnId);
    return row ? mapLingTurn(row as Record<string, SQLOutputValue>) : undefined;
  }

  listLingTurns(options: ListLingTurnsOptions): LingTurn[] {
    const clauses = ["workspace_id = ?", "thread_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.threadId];
    if (options.beforeUpdatedAt) {
      clauses.push("updated_at < ?");
      params.push(options.beforeUpdatedAt);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${lingTurnSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapLingTurn(row as Record<string, SQLOutputValue>));
  }

  linkRunToLingTurn(input: LinkRunToLingTurnInput): LingTurnRun {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const link = this.insertLingTurnRun(input.turnId, input.runId, input.role ?? "primary", input.now);
      this.reconcileLingTurnStatus(input.turnId, input.now);
      this.context.database.exec("COMMIT");
      this.ports.rebuildLingThreadMetadataForTurn(input.turnId, input.now);
      return link;
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getLingTurnForRun(runId: string): LingTurn | undefined {
    const row = this.context.database
      .prepare(`
        ${lingTurnSelectSql("INNER JOIN ling_turn_runs ON ling_turn_runs.turn_id = ling_turns.id WHERE ling_turn_runs.run_id = ?")}
      `)
      .get(runId);
    return row ? mapLingTurn(row as Record<string, SQLOutputValue>) : undefined;
  }

  listLingTurnRuns(turnId: string): LingTurnRun[] {
    return this.context.database
      .prepare(`
        SELECT turn_id, run_id, attempt_number, role, created_at
        FROM ling_turn_runs
        WHERE turn_id = ?
        ORDER BY attempt_number ASC, created_at ASC, run_id ASC
      `)
      .all(turnId)
      .map((row) => mapLingTurnRun(row as Record<string, SQLOutputValue>));
  }

  reconcileLingTurnStatus(turnId: string, now: string): LingTurn | undefined {
    const turn = this.getLingTurn(turnId);
    if (!turn) {
      return undefined;
    }
    const links = this.listLingTurnRuns(turnId);
    const runs = links
      .map((link) => ({ link, run: this.ports.getRun(link.runId) }))
      .filter((item): item is { readonly link: LingTurnRun; readonly run: RunSession } => Boolean(item.run));
    const latest = [...runs]
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const latestWaiting = [...runs]
      .filter((item) => item.run.status === "waiting_for_approval")
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const latestActive = latestWaiting ?? [...runs]
      .filter((item) => item.run.status === "queued" || item.run.status === "running")
      .sort((left, right) =>
        right.link.attemptNumber - left.link.attemptNumber ||
        right.run.updatedAt.localeCompare(left.run.updatedAt) ||
        right.run.id.localeCompare(left.run.id),
      )[0];
    const inputWaitStatus = projectTurnUserInputWait(
      this.context.database, this.ports.getUserInputWait, turn, runs.map(item => item.run), latest?.run.id,
    );
    const nextStatus: LingTurnStatus = turn.status === "superseded"
      ? "superseded"
      : latestWaiting
        ? "waiting_for_approval"
        : latestActive
          ? "running"
          : inputWaitStatus
            ? inputWaitStatus
          : latest
            ? runStatusToLingTurnStatus(latest.run.status)
            : "open";
    const terminal = nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "cancelled" || nextStatus === "superseded";
    this.context.database
      .prepare(`
        UPDATE ling_turns
        SET status = ?,
            active_run_id = ?,
            last_run_id = ?,
            updated_at = ?,
            completed_at = ?
        WHERE id = ?
      `)
      .run(
        nextStatus,
        latestActive?.run.id ?? null,
        latest?.run.id ?? null,
        now,
        terminal ? (turn.completedAt ?? now) : null,
        turnId,
      );
    this.ports.rebuildLingThreadMetadata(turn.threadId, now);
    return this.getLingTurn(turnId);
  }

  transitionLingTurnStatus(input: TransitionLingTurnStatusInput): TransitionResult<LingTurnStatus> {
    const turn = this.getLingTurn(input.turnId);
    if (!turn) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    let eventIdempotencyKey = input.idempotencyKey;
    if (input.idempotencyKey) {
      const existing = this.ports.findStateTransitionByIdempotency("turn", input.turnId, input.idempotencyKey);
      if (existing) {
        if (existing.toStatus === turn.status) {
          return { ok: true, from: turn.status, to: turn.status, duplicate: true };
        }
        eventIdempotencyKey = `${input.idempotencyKey}:repair:${turn.status}`;
        const repair = this.ports.findStateTransitionByIdempotency("turn", input.turnId, eventIdempotencyKey);
        if (repair && repair.toStatus === turn.status) {
          return { ok: true, from: turn.status, to: turn.status, duplicate: true };
        }
      }
    }
    const result = transitionLingTurn({
      entityId: input.turnId,
      currentStatus: turn.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: eventIdempotencyKey,
    });
    if (!result.ok) return result;
    const completed = result.to === "succeeded" || result.to === "failed" || result.to === "cancelled" || result.to === "superseded";
    const update = this.context.database
      .prepare(`
        UPDATE ling_turns
        SET status = ?, active_run_id = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(result.to, input.now, completed ? (turn.completedAt ?? input.now) : null, input.turnId, result.from);
    if (Number(update.changes) === 0) {
      return { ok: false, code: "stale_transition", currentStatus: this.getLingTurn(input.turnId)?.status ?? turn.status };
    }
    this.ports.recordStateTransitionEvent({
      workspaceId: turn.workspaceId,
      entityType: "turn",
      entityId: turn.id,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: eventIdempotencyKey,
      createdAt: input.now,
    });
    this.ports.rebuildLingThreadMetadata(turn.threadId, input.now);
    return result;
  }

  insertLingTurnRun(turnId: string, runId: string, role: LingTurnRunRole, createdAt: string): LingTurnRun {
    const turn = this.getLingTurn(turnId);
    if (!turn) {
      throw new Error(`Ling turn not found: ${turnId}`);
    }
    const thread = this.ports.getLingThread(turn.threadId);
    if (!thread) {
      throw new Error(`Ling thread not found for turn: ${turn.threadId}`);
    }
    if (thread.status === "archived") {
      throw new Error(`Ling thread is archived: ${thread.id}`);
    }
    const run = this.ports.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (run.threadId !== turn.threadId) {
      throw new Error(`Run does not belong to Ling turn thread: ${runId}`);
    }
    const row = this.context.database
      .prepare("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM ling_turn_runs WHERE turn_id = ?")
      .get(turnId);
    const attemptNumber = readNumber(row as Record<string, SQLOutputValue>, "next_attempt");
    this.context.database
      .prepare(`
        INSERT INTO ling_turn_runs (turn_id, run_id, attempt_number, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(turnId, runId, attemptNumber, role, createdAt);
    return {
      turnId,
      runId,
      attemptNumber,
      role,
      createdAt,
    };
  }

  reconcileLingTurnStatusForRun(runId: string, now: string): void {
    const turn = this.getLingTurnForRun(runId);
    if (turn) {
      this.reconcileLingTurnStatus(turn.id, now);
    }
  }

  private assertLingTurnRunReference(runId: string, threadId: string, fieldName: string): void {
    const run = this.ports.getRun(runId);
    if (!run) {
      throw new Error(`${fieldName} run not found: ${runId}`);
    }
    if (run.threadId !== threadId) {
      throw new Error(`${fieldName} run does not belong to Ling turn thread: ${runId}`);
    }
  }
}
