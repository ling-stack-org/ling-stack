import { createHash } from "node:crypto";
import type { CommitTeammateDirectMessageRuntimeInput, CommitTeammateDirectMessageRuntimeResult,
  TeammateDirectMessageRuntimeObservation, TeammateDirectMessageRuntimePatch, TeammateDirectMessageRuntimeScope,
  TeammateDirectMessageRuntimeState } from "../../teammate-direct-message-runtime-types.js";
import { isTeammateDirectRuntimeSource, projectTeammateDirectRuntimeReplyText, runtimeAttemptIdentity,
  runtimeRecord, sameTeammateDirectRuntimeFence } from "../../teammate-direct-message-runtime-validation.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import { ConversationNarrationAccumulator } from "../../conversation-narration-segments.js";
import { DEFAULT_WORKSPACE_ID, type TeammateDirectMessage } from "../../workspace-types.js";
import { readSqliteSnapshot, readSqliteWithinTransaction } from "./read-snapshot.js";
import { isCurrentRunExecutionOwner } from "./run-execution-admission.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readTeammateDirectRuntimeLifecycle, type TeammateDirectRuntimeReadPorts } from "./teammate-direct-message-runtime-proof.js";

interface RuntimeView {
  readonly observation: TeammateDirectMessageRuntimeObservation;
  readonly hasNarration: boolean;
  readonly hasMedia: boolean;
}

/** Private-message persistence boundary. No caller-controlled predicate or transaction is exposed. */
export class SqliteTeammateDirectMessageRuntimeStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: TeammateDirectRuntimeReadPorts) {}

  observe(scope: TeammateDirectMessageRuntimeScope): TeammateDirectMessageRuntimeObservation | undefined {
    return readSqliteSnapshot(this.context.database, () => {
      const safeScope = JSON.parse(JSON.stringify(scope)) as TeammateDirectMessageRuntimeScope;
      return this.load(safeScope)?.observation;
    });
  }

  commit(input: CommitTeammateDirectMessageRuntimeInput, now: string): CommitTeammateDirectMessageRuntimeResult {
    const { database } = this.context;
    // BEGIN is deliberately outside try: failure must not roll back a caller's read snapshot.
    database.exec("BEGIN IMMEDIATE");
    try {
      const checked = readSqliteWithinTransaction(database, () => {
        // Accessors/toJSON execute only while both the write lock and query_only are held.
        const safe = JSON.parse(JSON.stringify(input)) as CommitTeammateDirectMessageRuntimeInput;
        if (!safe || !safe.expected || !safe.operation || !runtimeRecord(safe.operation.patch)
          || typeof safe.expected.fingerprint !== "string" || typeof now !== "string" || !Number.isFinite(Date.parse(now))) {
          return { ok: false as const, rejection: "invalid_proof" as const };
        }
        const expectedScope = safe.expected.scope, expectedMessage = safe.expected.message;
        if (!expectedScope || !expectedMessage || expectedMessage.id !== expectedScope.messageId
          || expectedMessage.workspaceId !== expectedScope.workspaceId || expectedMessage.teammateId !== expectedScope.teammateId
          || expectedMessage.threadId !== expectedScope.threadId) return { ok: false as const, rejection: "owner_mismatch" as const };
        const view = this.load(safe.expected.scope);
        if (!view) return { ok: false as const, rejection: "not_found" as const };
        const current = view.observation;
        if (fingerprint(current.message) !== fingerprint(safe.expected.message)) return { ok: false as const, rejection: "stale" as const };
        if (current.state.kind === "indeterminate" && current.state.reason === "owner_mismatch") return { ok: false as const, rejection: "owner_mismatch" as const };
        if (current.fingerprint !== safe.expected.fingerprint) {
          return { ok: false as const, rejection: "stale" as const };
        }
        if (!this.authorize(safe, view)) return { ok: false as const, rejection: "invalid_proof" as const };
        const patch = safe.operation.patch, message = current.message;
        const next = { body: patch.body ?? message.body, status: patch.status ?? message.status,
          errorMessage: patch.errorMessage === undefined ? message.errorMessage ?? null : patch.errorMessage,
          linkedRunId: patch.linkedRunId === undefined ? message.linkedRunId ?? null : patch.linkedRunId };
        return { ok: true as const, current, next };
      });
      if (!checked.ok) {
        database.exec("COMMIT");
        return { kind: checked.rejection! };
      }
      const { current, next } = checked, message = current.message;
      if (next.body === message.body && next.status === message.status && next.errorMessage === (message.errorMessage ?? null)
        && next.linkedRunId === (message.linkedRunId ?? null)) {
        database.exec("COMMIT");
        return { kind: "unchanged", message };
      }
      const changed = database.prepare(`UPDATE teammate_direct_messages SET body=?,status=?,error_message=?,linked_run_id=?,updated_at=?
        WHERE id=? AND workspace_id=? AND teammate_id=? AND thread_id=? AND author_type='ai-teammate' AND author_id IS ?
        AND body=? AND status=? AND error_message IS ? AND linked_run_id IS ?`).run(
        next.body, next.status, next.errorMessage, next.linkedRunId, now, message.id, message.workspaceId, message.teammateId,
        message.threadId, message.authorId ?? null, message.body, message.status, message.errorMessage ?? null, message.linkedRunId ?? null);
      if (Number(changed.changes) !== 1) {
        database.exec("ROLLBACK");
        return { kind: "stale" };
      }
      const updated = this.ports.getTeammateDirectMessage(message.id);
      if (!updated) throw new Error("Private runtime commit could not reload its message");
      database.exec("COMMIT");
      return { kind: "applied", message: updated };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private authorize(input: CommitTeammateDirectMessageRuntimeInput, view: RuntimeView): boolean {
    const { observation: current } = view, { message, state, run, attempt } = current;
    const operation = input.operation, patch = operation.patch;
    if (Object.keys(patch).some(key => !["body", "status", "errorMessage", "linkedRunId"].includes(key))
      || patch.body !== undefined && typeof patch.body !== "string"
      || patch.errorMessage !== undefined && patch.errorMessage !== null && typeof patch.errorMessage !== "string"
      || patch.linkedRunId !== undefined && patch.linkedRunId !== null && typeof patch.linkedRunId !== "string") return false;
    const target = patch.status ?? message.status;
    if (message.status === "cancelled" && target !== "cancelled") return false;
    if (operation.kind === "pre_dispatch") {
      return state.kind === "unlinked" && message.linkedRunId === undefined
        && (message.status === "pending" || message.status === "blocked" && samePatch(message, patch))
        && (target === "pending" || target === "blocked") && (patch.linkedRunId === undefined || patch.linkedRunId === null);
    }
    if (state.kind === "indeterminate" || state.kind === "unlinked") return false;
    if (patch.linkedRunId !== undefined && patch.linkedRunId !== (run?.id ?? null)) return false;
    // A first link is permitted only to the validated scope Run, never to an arbitrary patch ID.
    if (run && message.linkedRunId === undefined && patch.linkedRunId !== run.id) return false;
    if (operation.kind === "execution") {
      const fence = runtimeRecord(operation.fence);
      return Boolean(fence && [fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken]
        .every(value => typeof value === "string" && value.length > 0))
        && state.kind === "active" && message.status === "pending" && target === "pending" && Boolean(run && attempt)
        && sameTeammateDirectRuntimeFence(operation.fence, toRuntimeAttemptFence(attempt!))
        && isCurrentRunExecutionOwner(this.context, run!.id, operation.fence, false);
    }
    if (operation.kind !== "reconcile") return false;
    if (state.kind === "active" || state.kind === "logical_wait") {
      return target === "pending" && message.status !== "ready" && message.status !== "cancelled"
        && (patch.errorMessage === undefined || patch.errorMessage === null);
    }
    if (state.kind !== "terminal") return false;
    if (state.status === "cancelled") return target === "cancelled";
    if (state.status === "failed") return target === "failed";
    // Stored localized error text is not successful narrative on a repeated empty-result hook.
    return view.hasNarration || view.hasMedia ? target === "ready" : target === "failed";
  }

  private load(scope: TeammateDirectMessageRuntimeScope): RuntimeView | undefined {
    if (!scope || ![scope.workspaceId, scope.teammateId, scope.threadId, scope.messageId].every(value => typeof value === "string" && value.length > 0)) return undefined;
    const { database } = this.context, message = this.ports.getTeammateDirectMessage(scope.messageId);
    if (!message) return undefined;
    const nativeThread = database.prepare("SELECT id,workspace_id,teammate_id FROM teammate_direct_threads WHERE id=?").get(scope.threadId);
    const base = { scope, message, lastRunEventSeq: 0 };
    const result = (state: TeammateDirectMessageRuntimeState, extra: Partial<TeammateDirectMessageRuntimeObservation> = {},
      witness: unknown = null, hasNarration = false, hasMedia = false): RuntimeView => {
      const observation = { ...base, ...extra, state, fingerprint: fingerprint({ scope, message, state, witness }) };
      return { observation, hasNarration, hasMedia };
    };
    const ownerMismatch = () => result({ kind: "indeterminate", reason: "owner_mismatch" });
    if (scope.workspaceId !== DEFAULT_WORKSPACE_ID || message.workspaceId !== scope.workspaceId || message.teammateId !== scope.teammateId
      || message.threadId !== scope.threadId || message.authorType !== "ai-teammate"
      || message.authorId !== undefined && message.authorId !== scope.teammateId || !nativeThread
      || nativeThread.workspace_id !== scope.workspaceId || nativeThread.teammate_id !== scope.teammateId
      || scope.runId !== undefined && message.linkedRunId !== undefined && scope.runId !== message.linkedRunId) return ownerMismatch();
    // Creation precedes writeReady. Null message.linkedRunId alone does not prove pre-dispatch.
    const candidates = !message.linkedRunId ? database.prepare(`SELECT id,linked_run_id FROM work_units
      WHERE workspace_id=? AND kind='teammate_direct_reply' AND linked_message_id=? ORDER BY created_at,id LIMIT 2`)
      .all(scope.workspaceId, message.id) : [];
    if (candidates.length > 1) return result({ kind: "indeterminate", reason: "ambiguous_work_unit_owner" });
    const discovered = candidates[0];
    const runId = scope.runId ?? message.linkedRunId ?? (typeof discovered?.linked_run_id === "string" ? discovered.linked_run_id : undefined);
    const unitId = scope.workUnitId ?? (typeof discovered?.id === "string" ? discovered.id : undefined);
    if (!runId && !unitId) return result({ kind: "unlinked" });
    const run = runId ? this.ports.getRun(runId) : undefined;
    const unit = (run?.workUnitId ?? unitId) ? this.ports.getWorkUnit((run?.workUnitId ?? unitId)!) : undefined;
    if (runId && !run || !unit || scope.workUnitId !== undefined && scope.workUnitId !== unit.id) return ownerMismatch();
    let turn: import("../../run-types.js").LingTurn | undefined;
    try {
      const request = runtimeRecord(run?.requestSnapshot ?? unit.request);
      turn = run ? this.ports.getLingTurnForRun(run.id) : typeof request?.turnId === "string" ? this.ports.getLingTurn(request.turnId) : undefined;
      const thread = turn ? this.ports.getLingThread(turn.threadId) : undefined;
      const item = turn?.sourceItemId ? this.ports.getConversationItem(turn.sourceItemId) : undefined;
      const source = typeof request?.sourceMessageId === "string" ? this.ports.getTeammateDirectMessage(request.sourceMessageId) : undefined;
      if (!request || !turn || !thread || !item || !source) return ownerMismatch();
      const turnId = turn.id;
      const snapshot = this.ports.getTeammateDirectInputSnapshot(item.id, scope.teammateId);
      if (!snapshot || !isTeammateDirectRuntimeSource({ scope, message, run, unit, thread, turn, item, source, snapshot, request })
        || run && this.ports.listLingTurnRuns(turnId).filter(link => link.runId === run.id && link.turnId === turnId).length !== 1) return ownerMismatch();
      const attempt = unit.activeAttemptId ? this.ports.getWorkUnitAttempt(unit.activeAttemptId) : undefined;
      if (!run) {
        const cancelled = unit.linkedRunId === undefined && unit.status === "cancelled" && Boolean(unit.endedAt)
          && (unit.activeAttemptId ? attempt && attempt.workUnitId === unit.id && attempt.status === "cancelled" && attempt.endedAt
            && attempt.runtimeInstanceId && attempt.fencingToken : unit.attemptCount === 0);
        return result(cancelled ? { kind: "terminal", status: "cancelled" } : { kind: "indeterminate", reason: "invalid_standalone_cancellation" },
          { workUnit: unit, attempt, turn }, { unit: unitIdentity(unit), attempt: runtimeAttemptIdentity(attempt), source: snapshot.fingerprint });
      }
      const tail = database.prepare("SELECT id,seq FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(run.id);
      const lifecycle = readTeammateDirectRuntimeLifecycle(this.context, this.ports, run, unit, attempt, turn);
      const media = lifecycle.state.kind === "terminal" && lifecycle.state.status === "succeeded" ? this.readMedia(run.id) : [];
      const hasMedia = media.length > 0;
      const hasNarration = lifecycle.state.kind === "terminal" && lifecycle.state.status === "succeeded" ? this.hasNarration(run.id, turn.id, turn.threadId, unit.id, scope.teammateId) : false;
      return result(lifecycle.state, { run, workUnit: unit, attempt: lifecycle.attempt ?? attempt, turn, lastRunEventSeq: Number(tail?.seq ?? 0) }, {
        run: { id: run.id, status: run.status, endedAt: run.endedAt, workUnitId: run.workUnitId, request: run.requestSnapshot, errorMessage: run.errorMessage },
        unit: unitIdentity(unit), attempt: runtimeAttemptIdentity(lifecycle.attempt ?? attempt),
        turn: { id: turn.id, status: turn.status, sourceItemId: turn.sourceItemId, activeRunId: turn.activeRunId, lastRunId: turn.lastRunId },
        source: snapshot.fingerprint, tail, proof: lifecycle.witness, media,
      }, hasNarration, hasMedia);
    } catch {
      return result({ kind: "indeterminate", reason: "invalid_proof" }, { run, workUnit: unit, turn });
    }
  }

  private hasNarration(runId: string, turnId: string, threadId: string, unitId: string, teammateId: string): boolean {
    const narration = new ConversationNarrationAccumulator({ runId });
    let afterSeq = 0;
    for (;;) {
      const events = this.ports.listEvents(runId, { afterSeq, limit: 1000 });
      if (!events.length) break;
      for (const event of events) {
        const data = event.data as Readonly<Record<string, unknown>>;
        if (event.runId !== runId || data.turnId !== undefined && data.turnId !== turnId || data.threadId !== undefined && data.threadId !== threadId
          || data.workUnitId !== undefined && data.workUnitId !== unitId || data.teammateId !== undefined && data.teammateId !== teammateId) return false;
        if (typeof data.attemptId === "string" && this.ports.getWorkUnitAttempt(data.attemptId)?.workUnitId !== unitId) return false;
        narration.append(event);
      }
      const next = events.at(-1)!.seq;
      if (next <= afterSeq) break;
      afterSeq = next;
    }
    return projectTeammateDirectRuntimeReplyText(narration.snapshot().content).trim().length > 0;
  }

  private readMedia(runId: string): unknown[] {
    return this.ports.listWorkUnits({ kind: "media_job", linkedRunId: runId, limit: 500 }).flatMap(unit => {
      const request = runtimeRecord(unit.request), target = runtimeRecord(request?.target), ref = runtimeRecord(target?.ref);
      const job = unit.linkedMediaJobId ? this.ports.getMediaJob(unit.linkedMediaJobId) : undefined;
      return unit.ownerType === "conversation_run" && unit.ownerId === runId && request?.source === "conversation_media_tool"
        && target && (ref?.kind === "provider" || ref?.kind === "workflow") && typeof target.id === "string" && target.id.trim()
        && typeof target.displayName === "string" && target.displayName.trim() && job && ["image_generate", "video_generate"].includes(job.operation)
        ? [{ id: unit.id, mediaJobId: job.id, status: job.status, updatedAt: job.updatedAt }] : [];
    });
  }
}

function samePatch(message: TeammateDirectMessage, patch: TeammateDirectMessageRuntimePatch): boolean {
  return (patch.body === undefined || patch.body === message.body) && (patch.status === undefined || patch.status === message.status)
    && (patch.errorMessage === undefined || patch.errorMessage === (message.errorMessage ?? null));
}
function unitIdentity(unit: import("../../runtime-supervisor-types.js").WorkUnit): unknown {
  return { id: unit.id, status: unit.status, activeAttemptId: unit.activeAttemptId, linkedRunId: unit.linkedRunId,
    linkedMessageId: unit.linkedMessageId, ownerType: unit.ownerType, ownerId: unit.ownerId, request: unit.request,
    endedAt: unit.endedAt, errorCode: unit.errorCode, errorMessage: unit.errorMessage };
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]));
  return value;
}
