import type { ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  APPLY_PATCH_FORMAT,
  ApplyPatchError,
  applyPatchPlan,
  invertPatchPlan,
  type ApprovalRequest,
  type PatchOperation,
  type PatchPlan,
  type PatchSummary,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type {
  RunWorkspaceChangeFile,
  RunWorkspaceChangesResponse,
  TurnWorkspaceChangesResponse,
  WorkspaceMutationRecord,
} from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import {
  assertNoInternalPatchPaths,
  assertNoSymlinkEscapes,
  assertPatchPathsWithinAllowedWritePaths,
  atomicWriteWorkspaceTextFile,
  deleteWorkspaceFile,
  readWorkspaceTextFile,
} from "./patch-actions.js";

export type RecoveryAction = "undo" | "reapply";

const workspaceRecoveryLocks = new Map<string, Promise<void>>();

export interface RunPatchSet {
  readonly approvals: readonly ApprovalRequest[];
  readonly plans: readonly PatchPlan[];
  readonly mutationRecords: readonly WorkspaceMutationRecord[];
  readonly provenanceComplete: boolean;
  readonly files: readonly RunWorkspaceChangeFile[];
  readonly summary: PatchSummary;
}

export interface RecoveryPreflight {
  readonly paths: readonly string[];
  readonly before: ReadonlyMap<string, string | undefined>;
  readonly after: ReadonlyMap<string, string | undefined>;
}

export interface RecoveryIntentFile {
  readonly path: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
}

interface RecoveryIntent {
  readonly action: RecoveryAction;
  readonly recoveryId: string;
  readonly idempotencyKey?: string;
  readonly files: readonly RecoveryIntentFile[];
}

interface RecoveryObservation {
  readonly state: "applied" | "undone";
  readonly updatedAt?: string;
  readonly conflict?: string;
  /** The latest recovery intent reached its after-state before the terminal event was persisted. */
  readonly completedIntent?: RecoveryIntent;
}

export interface RecoveryPlanStep {
  readonly plan: PatchPlan;
  readonly allowedWritePathSets: readonly (readonly string[])[];
}

export async function handleGetRunWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): Promise<void> {
  const resolved = resolveRunStore(storeRegistry, runId, url.searchParams.get("cwd") ?? undefined);
  if (!resolved) {
    writeJson(response, 404, { error: "run_not_found", message: "Run was not found in the active daemon stores." });
    return;
  }
  writeJson(response, 200, await buildRunWorkspaceChangesResponse(resolved.store, resolved.run));
}

export async function handleMutateRunWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
  action: RecoveryAction,
): Promise<void> {
  const resolved = resolveRunStore(storeRegistry, runId, url.searchParams.get("cwd") ?? undefined);
  if (!resolved) {
    writeJson(response, 404, { error: "run_not_found", message: "Run was not found in the active daemon stores." });
    return;
  }

  const { store, run } = resolved;
  try {
    writeJson(response, 200, await recoverRunWorkspaceChanges(store, run, action));
  } catch (error) {
    const statusCode = error instanceof RunWorkspaceRecoveryError ? error.statusCode : recoveryErrorStatus(error);
    writeJson(response, statusCode, {
      error: error instanceof RunWorkspaceRecoveryError
        ? error.code
        : statusCode === 403 ? "workspace_change_forbidden" : statusCode === 409 ? "workspace_change_conflict" : "workspace_change_recovery_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recoverRunWorkspaceChanges(
  store: RunStore,
  run: RunSession,
  action: RecoveryAction,
): Promise<RunWorkspaceChangesResponse> {
  return withWorkspaceRecoveryLock(run.cwd, () => recoverRunWorkspaceChangesLocked(store, run, action));
}

async function recoverRunWorkspaceChangesLocked(
  store: RunStore,
  run: RunSession,
  action: RecoveryAction,
): Promise<RunWorkspaceChangesResponse> {
  if (!isTerminalRun(run)) {
    throw new RunWorkspaceRecoveryError(409, "run_not_terminal", "Workspace changes can be recovered only after the run is complete.");
  }
  const patchSet = collectRunPatchSet(store, run.id);
  if (patchSet.plans.length === 0) {
    throw new RunWorkspaceRecoveryError(409, "workspace_changes_unavailable", "This run has no successfully applied reversible patch records.");
  }
  const events = runScopedRecoveryEvents(listAllRunEvents(store, run.id));
  const observation = observeRecoveryState(run.cwd, patchSet, events);
  if (observation.conflict) {
    throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", observation.conflict);
  }
  if (observation.completedIntent && observation.completedIntent.action === action) {
    store.appendEvent(run.id, observation.completedIntent.action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied", {
      recoveryId: observation.completedIntent.recoveryId,
      cwd: run.cwd,
      approvalIds: patchSet.approvals.map((approval) => approval.id),
      rawPatchSha256: patchSet.plans.map((plan) => plan.rawPatchSha256),
      touchedPaths: patchSet.files.map((file) => file.path),
      summary: patchSet.summary,
    });
    return buildRunWorkspaceChangesResponse(store, run);
  }
  const currentState = observation.state;
  if ((action === "undo" && currentState === "undone") || (action === "reapply" && currentState !== "undone")) {
    throw new RunWorkspaceRecoveryError(
      409,
      "workspace_change_invalid_state",
      action === "undo" ? "This run's patch is already undone." : "This run's patch must be undone before it can be reapplied.",
    );
  }

  const allowedWritePathSets = readAllowedWritePathSets(store, run);
  const plans = recoveryPlans(patchSet.plans, action);
  const preflight = await preflightPatchSequence(run.cwd, allowedWritePathSets, plans);
  const recoveryId = randomUUID();
  store.appendEvent(run.id, "workspace_change_recovery_started", {
    action,
    recoveryId,
    cwd: run.cwd,
    files: recoveryIntentFiles(preflight),
  });
  commitRecovery(run.cwd, preflight);
  store.appendEvent(run.id, action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied", {
    recoveryId,
    cwd: run.cwd,
    approvalIds: patchSet.approvals.map((approval) => approval.id),
    rawPatchSha256: patchSet.plans.map((plan) => plan.rawPatchSha256),
    touchedPaths: preflight.paths,
    summary: patchSet.summary,
  });
  return buildRunWorkspaceChangesResponse(store, run);
}

/** Resolve every retry/resume Run for one canonical Ling Turn and recover its durable mutations. */
export async function recoverTurnWorkspaceChanges(
  store: RunStore,
  turn: import("@ling-stack/core").LingTurn,
  action: RecoveryAction,
  idempotencyKey: string,
): Promise<TurnWorkspaceChangesResponse> {
  if (!idempotencyKey.trim()) throw new RunWorkspaceRecoveryError(400, "idempotency_key_required", "A recovery idempotency key is required.");
  const links = store.listLingTurnRuns(turn.id);
  const runs = links.map((link) => store.getRun(link.runId)).filter((run): run is RunSession => Boolean(run));
  const cwd = resolveTurnWorkspaceCwd(runs, store.paths.cwd);
  return withWorkspaceRecoveryLock(cwd, async () => {
    const context = buildTurnRecoveryContext(store, turn, runs);
    if (context.runs.length === 0) throw new RunWorkspaceRecoveryError(404, "turn_runs_not_found", `No Runs are linked to Turn: ${turn.id}`);
    if (context.runs.some((run) => !isTerminalRun(run))) throw new RunWorkspaceRecoveryError(409, "turn_not_terminal", "Workspace changes can be recovered only after all Turn Runs are complete.");
    if (!context.provenanceComplete) throw new RunWorkspaceRecoveryError(409, "provenance_missing", "Undo is unavailable: durable workspace provenance is incomplete.");
    if (context.steps.length === 0) throw new RunWorkspaceRecoveryError(409, "workspace_changes_unavailable", "This Turn has no successfully applied reversible workspace mutations.");
    const ownerRun = context.runs.at(-1)!;
    const durableRecord = store.listPostCompactionUndoRecords({
      workspaceId: turn.workspaceId,
      targetTurnId: turn.id,
      idempotencyKey,
      limit: 1,
    })[0];
    if (durableRecord && durableRecord.action !== action) {
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "This idempotency key is already bound to the opposite recovery action.");
    }
    if (durableRecord && (durableRecord.state === "conflict" || durableRecord.state === "failed" || durableRecord.state === "expired" || durableRecord.state === "provenance_missing" || durableRecord.state === "snapshot_unverified")) {
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", `The durable recovery record is ${durableRecord.state}; use a new idempotency key after review.`);
    }
    if (durableRecord && ((action === "undo" && durableRecord.state === "undone") || (action === "reapply" && durableRecord.state === "applied"))) {
      return buildTurnWorkspaceChangesResponse(store, turn);
    }
    const events = turnRecoveryEvents(store, ownerRun.id, turn.id);
    const prior = events.find((event) => isRecord(event.data) && event.data.idempotencyKey === idempotencyKey && event.type === (action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied"));
    if (prior) {
      if (durableRecord) {
        if (durableRecord.state === "available") {
          const claimed = store.updatePostCompactionUndoRecord({
            id: durableRecord.id,
            expectedState: "available",
            state: "validating",
            lastEventSeq: prior.seq,
            updatedAt: prior.ts,
          });
          if (!claimed) {
            throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Another recovery request owns this durable recovery record.");
          }
        }
        if (durableRecord.state === "available" || durableRecord.state === "validating") {
          const settled = store.updatePostCompactionUndoRecord({
            id: durableRecord.id,
            expectedState: "validating",
            state: action === "undo" ? "undone" : "applied",
            lastEventSeq: prior.seq,
            updatedAt: prior.ts,
          });
          if (!settled) {
            throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Another recovery request owns this durable recovery record.");
          }
        }
      }
      return buildTurnWorkspaceChangesResponse(store, turn);
    }
    const patchSet = syntheticPatchSet(context.steps.map((step) => step.plan));
    const observation = observeRecoveryState(cwd, patchSet, events);
    if (observation.conflict) {
      if (durableRecord?.state === "available" || durableRecord?.state === "validating") {
        store.updatePostCompactionUndoRecord({
          id: durableRecord.id,
          expectedState: durableRecord.state,
          state: "conflict",
          lastEventSeq: events.at(-1)?.seq ?? durableRecord.lastEventSeq,
          updatedAt: new Date().toISOString(),
        });
      }
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", observation.conflict);
    }
    if (observation.completedIntent) {
      if (observation.completedIntent.action === action && observation.completedIntent.idempotencyKey === idempotencyKey) {
        // A crash can occur after the recovery intent is persisted and the
        // workspace reaches its target state, but before the durable request
        // record is created (or before the terminal event is written). Rebuild
        // the record from the intent so the idempotency key remains durable
        // across daemon restarts instead of treating this as an unindexed
        // side-effect.
        const recoveredRecord = durableRecord ?? store.createPostCompactionUndoRecord({
          idempotencyKey,
          workspaceId: turn.workspaceId,
          threadId: turn.threadId,
          targetTurnId: turn.id,
          targetRunIds: context.runs.map((run) => run.id),
          checkpointId: findTurnCheckpoint(store, turn)?.id,
          expectedWorkspaceFingerprint: recoveryIntentFingerprint(observation.completedIntent, "before"),
          action,
          affectedPaths: observation.completedIntent.files.map((file) => file.path),
          createdAt: observation.updatedAt ?? new Date().toISOString(),
        });
        if (recoveredRecord.state === "available") {
          const claimed = store.updatePostCompactionUndoRecord({
            id: recoveredRecord.id,
            expectedState: "available",
            state: "validating",
            lastEventSeq: events.at(-1)?.seq ?? recoveredRecord.lastEventSeq,
            updatedAt: observation.updatedAt ?? new Date().toISOString(),
          });
          if (!claimed) {
            throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Another recovery request owns this durable recovery record.");
          }
        }
        if (recoveredRecord.state === "available" || recoveredRecord.state === "validating") {
          const terminalEvent = store.appendEvent(ownerRun.id, action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied", {
            scope: "turn",
            turnId: turn.id,
            runIds: context.runs.map((run) => run.id),
            recoveryId: observation.completedIntent.recoveryId,
            idempotencyKey,
            cwd,
            approvalIds: context.steps.flatMap((step) => step.approvals),
            rawPatchSha256: context.steps.map((step) => step.plan.rawPatchSha256),
            touchedPaths: patchSet.files.map((file) => file.path),
            summary: patchSet.summary,
          });
          store.updatePostCompactionUndoRecord({
            id: recoveredRecord.id,
            expectedState: "validating",
            state: action === "undo" ? "undone" : "applied",
            lastEventSeq: terminalEvent.seq,
            updatedAt: terminalEvent.ts,
          });
        }
        return buildTurnWorkspaceChangesResponse(store, turn);
      }
    }
    if ((action === "undo" && observation.state === "undone") || (action === "reapply" && observation.state !== "undone")) {
      throw new RunWorkspaceRecoveryError(409, "workspace_change_invalid_state", action === "undo" ? "This Turn's patch is already undone." : "This Turn's patch must be undone before reapply.");
    }
    let preflight: RecoveryPreflight;
    try {
      preflight = await preflightRecoveryPlanSequence(cwd, turnRecoveryPlanSteps(context.steps, action));
    } catch (error) {
      if (durableRecord?.state === "available" || durableRecord?.state === "validating") {
        store.updatePostCompactionUndoRecord({
          id: durableRecord.id,
          expectedState: durableRecord.state,
          state: "conflict",
          lastEventSeq: durableRecord.lastEventSeq,
          updatedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
    const expectedWorkspaceFingerprint = workspaceFingerprint(preflight.before);
    if (durableRecord && (durableRecord.state === "available" || durableRecord.state === "validating") && durableRecord.expectedWorkspaceFingerprint !== expectedWorkspaceFingerprint) {
      store.updatePostCompactionUndoRecord({
        id: durableRecord.id,
        expectedState: durableRecord.state,
        state: "conflict",
        lastEventSeq: durableRecord.lastEventSeq,
        updatedAt: new Date().toISOString(),
      });
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Workspace changed after the recovery request was validated; retry with a new idempotency key.");
    }
    const recoveryRecord = durableRecord ?? store.createPostCompactionUndoRecord({
      idempotencyKey,
      workspaceId: turn.workspaceId,
      threadId: turn.threadId,
      targetTurnId: turn.id,
      targetRunIds: context.runs.map((run) => run.id),
      checkpointId: findTurnCheckpoint(store, turn)?.id,
      expectedWorkspaceFingerprint,
      action,
      affectedPaths: preflight.paths,
      createdAt: new Date().toISOString(),
    });
    const recoveryId = randomUUID();
    const startedEvent = store.appendEvent(ownerRun.id, "workspace_change_recovery_started", {
      scope: "turn",
      turnId: turn.id,
      runIds: context.runs.map((run) => run.id),
      action,
      recoveryId,
      idempotencyKey,
      cwd,
      files: recoveryIntentFiles(preflight),
    });
    const validating = store.updatePostCompactionUndoRecord({
      id: recoveryRecord.id,
      expectedState: recoveryRecord.state === "available" ? "available" : "validating",
      state: "validating",
      lastEventSeq: startedEvent.seq,
      updatedAt: startedEvent.ts,
    });
    if (!validating) {
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Another recovery request owns this durable recovery record.");
    }
    try {
      commitRecovery(cwd, preflight);
    } catch (error) {
      store.updatePostCompactionUndoRecord({
        id: recoveryRecord.id,
        expectedState: "validating",
        state: "failed",
        lastEventSeq: startedEvent.seq,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
    const terminalEvent = store.appendEvent(ownerRun.id, action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied", {
      scope: "turn",
      turnId: turn.id,
      runIds: context.runs.map((run) => run.id),
      recoveryId,
      idempotencyKey,
      cwd,
      approvalIds: context.steps.flatMap((step) => step.approvals),
      rawPatchSha256: context.steps.map((step) => step.plan.rawPatchSha256),
      touchedPaths: preflight.paths,
      summary: summarizePatchPlans(context.steps.map((step) => step.plan)),
    });
    store.updatePostCompactionUndoRecord({
      id: recoveryRecord.id,
      expectedState: "validating",
      state: action === "undo" ? "undone" : "applied",
      lastEventSeq: terminalEvent.seq,
      updatedAt: terminalEvent.ts,
    });
    return buildTurnWorkspaceChangesResponse(store, turn);
  });
}

export async function buildTurnWorkspaceChangesResponse(
  store: RunStore,
  turn: import("@ling-stack/core").LingTurn,
): Promise<TurnWorkspaceChangesResponse> {
  const runs = store.listLingTurnRuns(turn.id).map((link) => store.getRun(link.runId)).filter((run): run is RunSession => Boolean(run));
  const context = buildTurnRecoveryContext(store, turn, runs);
  const steps = context.steps;
  const plans = steps.map((step) => step.plan);
  const ownerRun = runs.at(-1);
  let workspaceCwd: string;
  try {
    workspaceCwd = resolveTurnWorkspaceCwd(runs, store.paths.cwd);
  } catch (error) {
    const base = {
      cwd: ownerRun?.cwd ?? store.paths.cwd,
      threadId: turn.threadId,
      turnId: turn.id,
      runIds: runs.map((run) => run.id),
      files: summarizePatchFiles(plans),
      summary: summarizePatchPlans(plans),
      provenanceComplete: context.provenanceComplete,
      updatedAt: turn.updatedAt,
    } as const;
    return {
      ...base,
      state: "conflicted",
      canUndo: false,
      canReapply: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
  const events = ownerRun ? turnRecoveryEvents(store, ownerRun.id, turn.id) : [];
  const observation = ownerRun && plans.length > 0 ? observeRecoveryState(workspaceCwd, syntheticPatchSet(plans), events) : { state: "applied" as const };
  const durableRecovery = store.listPostCompactionUndoRecords({ workspaceId: turn.workspaceId, targetTurnId: turn.id, limit: 100 })[0];
  const checkpoint = findTurnCheckpoint(store, turn);
  const durableState = durableRecovery?.state === "undone" ? "undone"
    : durableRecovery?.state === "applied" ? "applied"
      : observation.state;
  const base = {
    cwd: workspaceCwd,
    threadId: turn.threadId,
    turnId: turn.id,
    runIds: runs.map((run) => run.id),
    files: summarizePatchFiles(plans),
    summary: summarizePatchPlans(plans),
    ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
    provenanceComplete: context.provenanceComplete,
    updatedAt: observation.updatedAt ?? durableRecovery?.updatedAt ?? turn.updatedAt,
  } as const;
  if (runs.length === 0) return { ...base, state: "unavailable", canUndo: false, canReapply: false, provenanceComplete: false, unavailableReason: "No Runs are linked to this Turn." };
  if (!context.provenanceComplete) return { ...base, state: "unavailable", canUndo: false, canReapply: false, unavailableReason: "Undo unavailable: durable workspace provenance is incomplete." };
  if (plans.length === 0) return { ...base, state: "unavailable", canUndo: false, canReapply: false, unavailableReason: "No successfully applied reversible workspace mutations were found." };
  if (observation.conflict || durableRecovery?.state === "conflict" || durableRecovery?.state === "failed") {
    return {
      ...base,
      state: "conflicted",
      canUndo: false,
      canReapply: false,
      unavailableReason: observation.conflict ?? `Recovery is ${durableRecovery?.state}; review the workspace before retrying.`,
    };
  }
  try {
    await preflightRecoveryPlanSequence(workspaceCwd, turnRecoveryPlanSteps(context.steps, durableState === "undone" ? "reapply" : "undo"));
    return { ...base, state: durableState, canUndo: durableState === "applied", canReapply: durableState === "undone" };
  } catch (error) {
    return { ...base, state: "conflicted", canUndo: false, canReapply: false, unavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

export async function handleGetTurnWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  turnId: string,
): Promise<void> {
  const store = storeRegistry.findStoreForTurn(turnId, url.searchParams.get("cwd") ?? undefined);
  const turn = store?.getLingTurn(turnId);
  if (!store || !turn) {
    writeJson(response, 404, { error: "turn_not_found", message: "Turn was not found in the active daemon stores." });
    return;
  }
  writeJson(response, 200, await buildTurnWorkspaceChangesResponse(store, turn));
}

export async function handleMutateTurnWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  turnId: string,
  action: RecoveryAction,
): Promise<void> {
  const store = storeRegistry.findStoreForTurn(turnId, url.searchParams.get("cwd") ?? undefined);
  const turn = store?.getLingTurn(turnId);
  if (!store || !turn) {
    writeJson(response, 404, { error: "turn_not_found", message: "Turn was not found in the active daemon stores." });
    return;
  }
  try {
    const idempotencyKey = url.searchParams.get("idempotencyKey") ?? "";
    writeJson(response, 200, await recoverTurnWorkspaceChanges(store, turn, action, idempotencyKey));
  } catch (error) {
    const statusCode = error instanceof RunWorkspaceRecoveryError ? error.statusCode : recoveryErrorStatus(error);
    writeJson(response, statusCode, {
      error: error instanceof RunWorkspaceRecoveryError ? error.code : statusCode === 403 ? "workspace_change_forbidden" : statusCode === 409 ? "workspace_change_conflict" : "workspace_change_recovery_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

interface TurnRecoveryStep {
  readonly run: RunSession;
  readonly plan: PatchPlan;
  readonly approvals: readonly string[];
  readonly minProvenanceSeq: number;
  readonly allowedWritePathSets: readonly (readonly string[])[];
}

function buildTurnRecoveryContext(store: RunStore, turn: import("@ling-stack/core").LingTurn, runs: readonly RunSession[]) {
  const steps: TurnRecoveryStep[] = [];
  let provenanceComplete = runs.length > 0;
  for (const run of runs) {
    const patchSet = collectRunPatchSet(store, run.id);
    if (patchSet.mutationRecords.length === 0) {
      if (patchSet.plans.length > 0) provenanceComplete = false;
      continue;
    }
    if (!patchSet.provenanceComplete) {
      provenanceComplete = false;
      continue;
    }
    // A Run can only contribute mutations when every durable record points
    // back to this exact Turn lineage and workspace. Do not allow a malformed
    // or legacy record to broaden a Turn-level undo target to another Turn.
    let recordsMatchTurn = true;
    try {
      recordsMatchTurn = patchSet.mutationRecords.every((record) =>
        record.runId === run.id
        && record.turnId === turn.id
        && record.threadId === turn.threadId
        && record.workspaceId === turn.workspaceId
        && resolvePath(record.cwd) === resolvePath(run.cwd),
      );
    } catch {
      recordsMatchTurn = false;
    }
    if (!recordsMatchTurn) {
      provenanceComplete = false;
      continue;
    }
    const byPlan = new Map<string, WorkspaceMutationRecord[]>();
    for (const record of patchSet.mutationRecords) {
      const group = byPlan.get(record.patchPlanId) ?? [];
      group.push(record);
      byPlan.set(record.patchPlanId, group);
    }
    for (const records of byPlan.values()) {
      const forwardId = records[0]?.forwardPatchArtifactId;
      const artifact = forwardId ? store.getArtifact(forwardId) : undefined;
      if (!artifact || !isPatchPlan(artifact.sealedPayload)) {
        provenanceComplete = false;
        continue;
      }
      let allowedWritePathSets: readonly (readonly string[])[];
      try {
        allowedWritePathSets = readAllowedWritePathSets(store, run);
      } catch {
        provenanceComplete = false;
        continue;
      }
      steps.push({
        run,
        plan: artifact.sealedPayload,
        approvals: [...new Set(records.flatMap((record) => record.approvalId ? [record.approvalId] : []))],
        minProvenanceSeq: Math.min(...records.map((record) => record.provenanceSeq)),
        allowedWritePathSets,
      });
    }
  }
  steps.sort((left, right) => left.minProvenanceSeq - right.minProvenanceSeq);
  return { turn, runs, steps, provenanceComplete };
}

function resolveTurnWorkspaceCwd(runs: readonly RunSession[], fallbackCwd: string): string {
  const canonicalCwd = resolvePath(runs[0]?.cwd ?? fallbackCwd);
  if (runs.some((run) => resolvePath(run.cwd) !== canonicalCwd)) {
    throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", "Linked Turn Runs resolve to different workspaces; recovery is blocked until the workspace lineage is repaired.");
  }
  return canonicalCwd;
}

function findTurnCheckpoint(store: RunStore, turn: import("@ling-stack/core").LingTurn) {
  return store.listCompactionCheckpoints({ threadId: turn.threadId, sourceTurnId: turn.id, limit: 1 })[0]
    ?? store.listCompactionCheckpoints({ threadId: turn.threadId, limit: 100 }).find((candidate) => candidate.coveredTurnIds.includes(turn.id));
}

function turnRecoveryPlanSteps(steps: readonly TurnRecoveryStep[], action: RecoveryAction): RecoveryPlanStep[] {
  const ordered = action === "undo" ? [...steps].reverse() : [...steps];
  return ordered.map((step) => ({
    plan: action === "undo" ? invertPatchPlan(step.plan) : step.plan,
    allowedWritePathSets: step.allowedWritePathSets,
  }));
}

function syntheticPatchSet(plans: readonly PatchPlan[]): RunPatchSet {
  return { approvals: [], plans, mutationRecords: [], provenanceComplete: true, files: summarizePatchFiles(plans), summary: summarizePatchPlans(plans) };
}

function turnRecoveryEvents(store: RunStore, ownerRunId: string, turnId: string): readonly RunEventEnvelope[] {
  return listAllRunEvents(store, ownerRunId).filter((event) => {
    if (!isRecord(event.data)) return false;
    return event.data.scope === "turn" && event.data.turnId === turnId;
  });
}

export async function withWorkspaceRecoveryLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolvePath(cwd);
  const previous = workspaceRecoveryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  workspaceRecoveryLocks.set(key, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceRecoveryLocks.get(key) === queued) workspaceRecoveryLocks.delete(key);
  }
}

export class RunWorkspaceRecoveryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunWorkspaceRecoveryError";
  }
}

export async function buildRunWorkspaceChangesResponse(
  store: RunStore,
  run: RunSession,
): Promise<RunWorkspaceChangesResponse> {
  const patchSet = collectRunPatchSet(store, run.id);
  const events = runScopedRecoveryEvents(listAllRunEvents(store, run.id));
  const observation = observeRecoveryState(run.cwd, patchSet, events);
  const recoveryState = observation.state;
  const updatedAt = observation.updatedAt ?? run.updatedAt;
  const base = {
    cwd: run.cwd,
    runId: run.id,
    files: patchSet.files,
    summary: patchSet.summary,
    updatedAt,
  } as const;

  if (!isTerminalRun(run)) {
    return { ...base, state: "unavailable", canUndo: false, canReapply: false, unavailableReason: "The run is still active." };
  }
  if (patchSet.plans.length === 0) {
    return { ...base, state: "unavailable", canUndo: false, canReapply: false, unavailableReason: "No successfully applied reversible patch records were found." };
  }
  if (observation.conflict) {
    return { ...base, state: "conflicted", canUndo: false, canReapply: false, unavailableReason: observation.conflict };
  }

  try {
    const allowedWritePathSets = readAllowedWritePathSets(store, run);
    const action: RecoveryAction = recoveryState === "undone" ? "reapply" : "undo";
    await preflightPatchSequence(run.cwd, allowedWritePathSets, recoveryPlans(patchSet.plans, action));
    return {
      ...base,
      state: recoveryState,
      canUndo: recoveryState === "applied",
      canReapply: recoveryState === "undone",
    };
  } catch (error) {
    return {
      ...base,
      state: "conflicted",
      canUndo: false,
      canReapply: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveRunStore(
  storeRegistry: RunStoreRegistry,
  runId: string,
  cwd?: string,
): { readonly store: RunStore; readonly run: RunSession } | undefined {
  const store = storeRegistry.findStoreForRun(runId, cwd);
  const run = store?.getRun(runId);
  return store && run ? { store, run } : undefined;
}

export function collectRunPatchSet(store: RunStore, runId: string): RunPatchSet {
  const mutationRecords = store.listWorkspaceMutationRecords({ runId, limit: 2_000 });
  if (mutationRecords.length > 0) {
    const durable = durablePatchPlans(store, mutationRecords);
    const approvals = uniqueApprovals(mutationRecords
      .flatMap((record) => record.approvalId ? [store.getApprovalRequest(record.approvalId)] : [])
      .filter((approval): approval is ApprovalRequest => Boolean(approval)));
    return {
      approvals,
      plans: durable.plans,
      mutationRecords,
      provenanceComplete: durable.complete,
      files: summarizePatchFiles(durable.plans),
      summary: summarizePatchPlans(durable.plans),
    };
  }
  const events = listAllRunEvents(store, runId);
  const successfulToolEnds = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "tool_end" || !isRecord(event.data) || event.data.isError === true) {
      continue;
    }
    const toolCallId = typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
    if (toolCallId) {
      successfulToolEnds.set(toolCallId, event.seq);
    }
  }

  const approvals = store.listApprovalRequests({ runId, status: "approved", limit: 500 })
    .filter((approval) => approval.toolCallId && successfulToolEnds.has(approval.toolCallId))
    .filter((approval) => patchPlanFromApproval(approval) !== undefined)
    .sort((left, right) => (successfulToolEnds.get(left.toolCallId ?? "") ?? 0) - (successfulToolEnds.get(right.toolCallId ?? "") ?? 0));
  const plans = approvals.map((approval) => patchPlanFromApproval(approval)).filter((plan): plan is PatchPlan => Boolean(plan));
  return {
    approvals,
    plans,
    mutationRecords: [],
    provenanceComplete: false,
    files: summarizePatchFiles(plans),
    summary: summarizePatchPlans(plans),
  };
}

function durablePatchPlans(
  store: RunStore,
  records: readonly WorkspaceMutationRecord[],
): { readonly plans: readonly PatchPlan[]; readonly complete: boolean } {
  const byPlan = new Map<string, WorkspaceMutationRecord[]>();
  for (const record of records) {
    const group = byPlan.get(record.patchPlanId) ?? [];
    group.push(record);
    byPlan.set(record.patchPlanId, group);
  }
  const ordered = [...byPlan.values()].sort((left, right) =>
    Math.min(...left.map((record) => record.provenanceSeq)) - Math.min(...right.map((record) => record.provenanceSeq)));
  const plans: PatchPlan[] = [];
  for (const group of ordered) {
    const artifactIds = new Set(group.map((record) => record.forwardPatchArtifactId).filter((id): id is string => Boolean(id)));
    const inverseArtifactIds = new Set(group.map((record) => record.inversePatchArtifactId));
    if (artifactIds.size !== 1 || inverseArtifactIds.size !== 1 || group.some((record) => record.effectState !== "applied")) {
      return { plans: [], complete: false };
    }
    const forwardArtifactId = [...artifactIds][0]!;
    const inverseArtifactId = [...inverseArtifactIds][0]!;
    const artifact = store.getArtifact(forwardArtifactId);
    const inverseArtifact = store.getArtifact(inverseArtifactId);
    if (!artifact || artifact.runId !== group[0]?.runId || !isPatchPlan(artifact.sealedPayload)) {
      return { plans: [], complete: false };
    }
    const plan = artifact.sealedPayload;
    if (!inverseArtifact || inverseArtifact.runId !== group[0]?.runId || !isPatchPlan(inverseArtifact.sealedPayload)
      || JSON.stringify(inverseArtifact.sealedPayload) !== JSON.stringify(invertPatchPlan(plan))
      || group.some((record) => record.forwardPatchArtifactId !== forwardArtifactId || record.inversePatchArtifactId !== inverseArtifactId)) {
      return { plans: [], complete: false };
    }
    const orderedRecords = [...group].sort((left, right) => left.operationIndex - right.operationIndex);
    if (orderedRecords.length !== plan.operations.length
      || orderedRecords.some((record, index) => {
        const operation = plan.operations[index];
        return !operation || record.operationIndex !== index || record.path !== operation.path || record.operation !== operation.kind;
      })) {
      return { plans: [], complete: false };
    }
    plans.push(plan);
  }
  return { plans, complete: plans.length > 0 };
}

function uniqueApprovals(approvals: readonly ApprovalRequest[]): ApprovalRequest[] {
  return [...new Map(approvals.map((approval) => [approval.id, approval])).values()];
}

function patchPlanFromApproval(approval: ApprovalRequest): PatchPlan | undefined {
  if (approval.payload.type !== "file_edit" && approval.payload.type !== "file_write") {
    return undefined;
  }
  const plan = approval.payload.patchPlan;
  return isPatchPlan(plan) ? plan : undefined;
}

export function isPatchPlan(value: unknown): value is PatchPlan {
  return isRecord(value) && value.format === APPLY_PATCH_FORMAT && Array.isArray(value.operations) && Array.isArray(value.touchedPaths) && isRecord(value.summary) && typeof value.rawPatchSha256 === "string";
}

export function recoveryPlans(plans: readonly PatchPlan[], action: RecoveryAction): readonly PatchPlan[] {
  return action === "undo" ? [...plans].reverse().map(invertPatchPlan) : plans;
}

async function preflightPatchSequence(
  cwd: string,
  allowedWritePathSets: readonly (readonly string[])[],
  plans: readonly PatchPlan[],
): Promise<RecoveryPreflight> {
  return preflightRecoveryPlanSequence(cwd, plans.map((plan) => ({ plan, allowedWritePathSets })));
}

export async function preflightRecoveryPlanSequence(
  cwd: string,
  steps: readonly RecoveryPlanStep[],
): Promise<RecoveryPreflight> {
  const paths = uniquePaths(steps.flatMap((step) => step.plan.touchedPaths));
  assertNoInternalPatchPaths(paths);
  for (const step of steps) {
    for (const allowedWritePaths of step.allowedWritePathSets) {
      assertPatchPathsWithinAllowedWritePaths(step.plan.touchedPaths, cwd, allowedWritePaths);
      assertNoSymlinkEscapes(step.plan.touchedPaths, cwd, allowedWritePaths);
    }
  }

  const before = new Map(paths.map((path) => [path, readWorkspaceTextFile(cwd, path)] as const));
  const after = new Map(before);
  for (const { plan } of steps) {
    await applyPatchPlan({
      plan,
      readFile: (path) => after.get(path),
      writeFile: (path, content) => {
        after.set(path, content);
      },
      deleteFile: (path) => {
        after.set(path, undefined);
      },
    });
  }
  return { paths, before, after };
}

export function commitRecovery(cwd: string, preflight: RecoveryPreflight): void {
  const committed: string[] = [];
  try {
    for (const path of preflight.paths) {
      const before = preflight.before.get(path);
      const after = preflight.after.get(path);
      if (before === after) {
        continue;
      }
      if (readWorkspaceTextFile(cwd, path) !== before) {
        throw new ApplyPatchError(`Workspace file changed after recovery preflight: ${path}`);
      }
      writeWorkspaceState(cwd, path, after);
      committed.push(path);
    }
  } catch (error) {
    for (const path of committed.reverse()) {
      try {
        if (readWorkspaceTextFile(cwd, path) === preflight.after.get(path)) {
          writeWorkspaceState(cwd, path, preflight.before.get(path));
        }
      } catch {
        // Best-effort rollback preserves the original error while limiting partial recovery.
      }
    }
    throw error;
  }
  for (const path of preflight.paths) {
    if (readWorkspaceTextFile(cwd, path) !== preflight.after.get(path)) {
      throw new ApplyPatchError(`Workspace recovery verification failed: ${path}`);
    }
  }
}

function writeWorkspaceState(cwd: string, path: string, content: string | undefined): void {
  if (content === undefined) {
    deleteWorkspaceFile(cwd, path);
  } else {
    atomicWriteWorkspaceTextFile(cwd, path, content);
  }
}

export function readAllowedWritePathSets(store: RunStore, run: RunSession): readonly (readonly string[])[] {
  if (!isRecord(run.requestSnapshot) || !isRecord(run.requestSnapshot.effectivePolicySnapshot)) {
    throw new ApplyPatchError("The run does not contain a recoverable write-scope snapshot.");
  }
  const snapshotPaths = run.requestSnapshot.effectivePolicySnapshot.allowedWritePaths;
  if (!Array.isArray(snapshotPaths) || !snapshotPaths.every((path) => typeof path === "string") || snapshotPaths.length === 0) {
    throw new ApplyPatchError("The run write-scope snapshot is missing or invalid.");
  }
  const currentPaths = store.getApprovalPolicy().allowedWritePaths;
  if (currentPaths.length === 0) {
    throw new ApplyPatchError("The current workspace write policy does not allow file recovery.");
  }
  return [snapshotPaths, currentPaths];
}

function latestRecoveryEvent(events: readonly RunEventEnvelope[]): RunEventEnvelope | undefined {
  return [...events].reverse().find((event) => event.type === "workspace_changes_undone" || event.type === "workspace_changes_reapplied");
}

function observeRecoveryState(
  cwd: string,
  patchSet: RunPatchSet,
  events: readonly RunEventEnvelope[],
): RecoveryObservation {
  const completed = latestRecoveryEvent(events);
  const completedState = completed?.type === "workspace_changes_undone" ? "undone" : "applied";
  const pendingEvent = [...events].reverse().find((event) =>
    event.type === "workspace_change_recovery_started" && event.seq > (completed?.seq ?? 0),
  );
  if (!pendingEvent) {
    return { state: completedState, updatedAt: completed?.ts };
  }
  const intent = readRecoveryIntent(pendingEvent.data, patchSet);
  if (!intent) {
    return {
      state: completedState,
      updatedAt: pendingEvent.ts,
      conflict: "The latest workspace recovery intent is invalid and requires manual review.",
    };
  }
  try {
    const currentHashes = new Map(intent.files.map((file) => [file.path, hashRecoveryContent(readWorkspaceTextFile(cwd, file.path))] as const));
    const matchesBefore = intent.files.every((file) => currentHashes.get(file.path) === file.beforeSha256);
    const matchesAfter = intent.files.every((file) => currentHashes.get(file.path) === file.afterSha256);
    if (matchesAfter) {
      return {
        state: intent.action === "undo" ? "undone" : "applied",
        updatedAt: pendingEvent.ts,
        completedIntent: intent,
      };
    }
    if (matchesBefore) {
      return { state: completedState, updatedAt: pendingEvent.ts };
    }
    return {
      state: completedState,
      updatedAt: pendingEvent.ts,
      conflict: "Workspace recovery was interrupted after changing only part of the recorded files. Review the workspace before retrying.",
    };
  } catch (error) {
    return {
      state: completedState,
      updatedAt: pendingEvent.ts,
      conflict: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recoveryIntentFiles(preflight: RecoveryPreflight): readonly RecoveryIntentFile[] {
  return preflight.paths.map((path) => ({
    path,
    beforeSha256: hashRecoveryContent(preflight.before.get(path)),
    afterSha256: hashRecoveryContent(preflight.after.get(path)),
  }));
}

function readRecoveryIntent(data: unknown, patchSet: RunPatchSet): RecoveryIntent | undefined {
  if (!isRecord(data) || (data.action !== "undo" && data.action !== "reapply") || typeof data.recoveryId !== "string" || !Array.isArray(data.files)) {
    return undefined;
  }
  const expectedPaths = new Set(uniquePaths(patchSet.plans.flatMap((plan) => plan.touchedPaths)));
  const files: RecoveryIntentFile[] = [];
  const seenPaths = new Set<string>();
  for (const value of data.files) {
    if (!isRecord(value) || typeof value.path !== "string" || typeof value.beforeSha256 !== "string" || typeof value.afterSha256 !== "string") {
      return undefined;
    }
    if (!expectedPaths.has(value.path) || seenPaths.has(value.path)) {
      return undefined;
    }
    seenPaths.add(value.path);
    files.push({ path: value.path, beforeSha256: value.beforeSha256, afterSha256: value.afterSha256 });
  }
  if (files.length === 0 || files.length !== expectedPaths.size) {
    return undefined;
  }
  return {
    action: data.action,
    recoveryId: data.recoveryId,
    ...(typeof data.idempotencyKey === "string" ? { idempotencyKey: data.idempotencyKey } : {}),
    files,
  };
}

export function hashRecoveryContent(content: string | undefined): string {
  const hash = createHash("sha256");
  if (content === undefined) {
    hash.update("missing\0", "utf8");
  } else {
    hash.update("text\0", "utf8");
    hash.update(content, "utf8");
  }
  return hash.digest("hex");
}

/** Stable fingerprint for the exact path set used by a recovery CAS decision. */
export function workspaceFingerprint(contents: ReadonlyMap<string, string | undefined>): string {
  const hash = createHash("sha256");
  for (const path of [...contents.keys()].sort()) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(hashRecoveryContent(contents.get(path)), "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function recoveryIntentFingerprint(intent: RecoveryIntent, side: "before" | "after"): string {
  const hash = createHash("sha256");
  for (const file of [...intent.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(side === "before" ? file.beforeSha256 : file.afterSha256, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function summarizePatchFiles(plans: readonly PatchPlan[]): readonly RunWorkspaceChangeFile[] {
  const files = new Map<string, { operationCount: number; additions: number; deletions: number }>();
  for (const operation of plans.flatMap((plan) => plan.operations)) {
    const current = files.get(operation.path) ?? { operationCount: 0, additions: 0, deletions: 0 };
    const lines = operationLineStats(operation);
    files.set(operation.path, {
      operationCount: current.operationCount + 1,
      additions: current.additions + lines.additions,
      deletions: current.deletions + lines.deletions,
    });
  }
  return [...files.entries()].map(([path, stats]) => ({ path, ...stats }));
}

export function summarizePatchPlans(plans: readonly PatchPlan[]): PatchSummary {
  const files = summarizePatchFiles(plans);
  return {
    fileCount: files.length,
    addCount: plans.reduce((sum, plan) => sum + plan.summary.addCount, 0),
    updateCount: plans.reduce((sum, plan) => sum + plan.summary.updateCount, 0),
    deleteCount: plans.reduce((sum, plan) => sum + plan.summary.deleteCount, 0),
    moveCount: plans.reduce((sum, plan) => sum + plan.summary.moveCount, 0),
    addedLines: files.reduce((sum, file) => sum + file.additions, 0),
    removedLines: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function operationLineStats(operation: PatchOperation): { readonly additions: number; readonly deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of operation.hunks.flatMap((hunk) => hunk.lines)) {
    if (line.kind === "add") {
      additions += 1;
    } else if (line.kind === "remove") {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

export function listAllRunEvents(store: RunStore, runId: string): readonly RunEventEnvelope[] {
  const events: RunEventEnvelope[] = [];
  let afterSeq = 0;
  while (true) {
    const page = store.listEvents(runId, { afterSeq, limit: 1000 });
    events.push(...page);
    if (page.length < 1000) {
      return events;
    }
    afterSeq = page.at(-1)?.seq ?? afterSeq;
  }
}

export function isTerminalRun(run: RunSession): boolean {
  return run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
}

export function recoveryErrorStatus(error: unknown): number {
  if (!(error instanceof ApplyPatchError)) {
    return 500;
  }
  return /outside allowed write paths|resolves outside|symlink resolves outside/iu.test(error.message) ? 403 : 409;
}

function runScopedRecoveryEvents(events: readonly RunEventEnvelope[]): readonly RunEventEnvelope[] {
  return events.filter((event) => {
    if (event.type !== "workspace_change_recovery_started" && event.type !== "workspace_changes_undone" && event.type !== "workspace_changes_reapplied") {
      return true;
    }
    return !isRecord(event.data) || event.data.scope === undefined;
  });
}
