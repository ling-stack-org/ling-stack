import type { ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
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

export interface RunPatchSet {
  readonly approvals: readonly ApprovalRequest[];
  readonly plans: readonly PatchPlan[];
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
  readonly files: readonly RecoveryIntentFile[];
}

interface RecoveryObservation {
  readonly state: "applied" | "undone";
  readonly updatedAt?: string;
  readonly conflict?: string;
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
    files: summarizePatchFiles(plans),
    summary: summarizePatchPlans(plans),
  };
}

function patchPlanFromApproval(approval: ApprovalRequest): PatchPlan | undefined {
  if (approval.payload.type !== "file_edit" && approval.payload.type !== "file_write") {
    return undefined;
  }
  const plan = approval.payload.patchPlan;
  return isPatchPlan(plan) ? plan : undefined;
}

function isPatchPlan(value: unknown): value is PatchPlan {
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
  return { action: data.action, recoveryId: data.recoveryId, files };
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
    return !isRecord(event.data) || event.data.scope !== "workflow";
  });
}
