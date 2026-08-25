import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import {
  invertPatchPlan,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type PatchPlan,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type { WorkflowWorkspaceChangesResponse } from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { readWorkspaceTextFile } from "../runs/patch-actions.js";
import {
  RunWorkspaceRecoveryError,
  collectRunPatchSet,
  commitRecovery,
  hashRecoveryContent,
  isTerminalRun,
  listAllRunEvents,
  preflightRecoveryPlanSequence,
  readAllowedWritePathSets,
  recoveryErrorStatus,
  recoveryIntentFiles,
  summarizePatchFiles,
  summarizePatchPlans,
  uniquePaths,
  withWorkspaceRecoveryLock,
  type RecoveryAction,
  type RecoveryIntentFile,
  type RecoveryPlanStep,
  type RunPatchSet,
} from "../runs/workspace-change-recovery.js";

interface WorkflowPatchRun {
  readonly run: RunSession;
  readonly stepPosition: number;
  readonly patchSet: RunPatchSet;
  readonly planAppliedAt: readonly string[];
  readonly allowedWritePathSets: readonly (readonly string[])[];
}

interface WorkflowRecoveryContext {
  readonly workflow: ChannelWorkflow;
  readonly runs: readonly RunSession[];
  readonly patchRuns: readonly WorkflowPatchRun[];
  readonly ownerRun?: RunSession;
  readonly cwd?: string;
  readonly unavailableReason?: string;
}

interface WorkflowRecoveryIntent {
  readonly action: RecoveryAction;
  readonly recoveryId: string;
  readonly files: readonly RecoveryIntentFile[];
}

interface WorkflowRecoveryObservation {
  readonly state: "applied" | "undone";
  readonly updatedAt?: string;
  readonly conflict?: string;
}

export async function handleGetWorkflowWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
): Promise<void> {
  const resolved = resolveWorkflowStore(storeRegistry, workflowId, url.searchParams.get("cwd") ?? undefined);
  if (!resolved) {
    writeJson(response, 404, { error: "workflow_not_found", message: "Workflow was not found in the active daemon stores." });
    return;
  }
  writeJson(response, 200, await buildWorkflowWorkspaceChangesResponse(resolved.store, resolved.workflow));
}

export async function handleMutateWorkflowWorkspaceChanges(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
  action: RecoveryAction,
): Promise<void> {
  const resolved = resolveWorkflowStore(storeRegistry, workflowId, url.searchParams.get("cwd") ?? undefined);
  if (!resolved) {
    writeJson(response, 404, { error: "workflow_not_found", message: "Workflow was not found in the active daemon stores." });
    return;
  }
  try {
    writeJson(response, 200, await recoverWorkflowWorkspaceChanges(resolved.store, resolved.workflow, action));
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

export async function recoverWorkflowWorkspaceChanges(
  store: RunStore,
  workflow: ChannelWorkflow,
  action: RecoveryAction,
): Promise<WorkflowWorkspaceChangesResponse> {
  const context = buildWorkflowRecoveryContext(store, workflow);
  assertWorkflowRecoveryAvailable(context);
  const cwd = context.cwd as string;
  return withWorkspaceRecoveryLock(cwd, async () => {
    const lockedContext = buildWorkflowRecoveryContext(store, workflow);
    assertWorkflowRecoveryAvailable(lockedContext);
    const lockedCwd = lockedContext.cwd as string;
    const lockedOwnerRun = lockedContext.ownerRun as RunSession;
    const lockedPlans = lockedContext.patchRuns.flatMap((item) => item.patchSet.plans);
    const observation = observeWorkflowRecoveryState(lockedCwd, workflow.id, lockedPlans, workflowRecoveryEvents(store, lockedOwnerRun.id, workflow.id));
    if (observation.conflict) {
      throw new RunWorkspaceRecoveryError(409, "workspace_change_conflict", observation.conflict);
    }
    if ((action === "undo" && observation.state === "undone") || (action === "reapply" && observation.state !== "undone")) {
      throw new RunWorkspaceRecoveryError(
        409,
        "workspace_change_invalid_state",
        action === "undo" ? "This workflow's patches are already undone." : "This workflow's patches must be undone before they can be reapplied.",
      );
    }

    const recoverySteps = workflowRecoveryPlanSteps(lockedContext.patchRuns, action);
    const preflight = await preflightRecoveryPlanSequence(lockedCwd, recoverySteps);
    const recoveryId = randomUUID();
    store.appendEvent(lockedOwnerRun.id, "workspace_change_recovery_started", {
      scope: "workflow",
      workflowId: workflow.id,
      runIds: lockedContext.patchRuns.map((item) => item.run.id),
      action,
      recoveryId,
      cwd: lockedCwd,
      files: recoveryIntentFiles(preflight),
    });
    commitRecovery(lockedCwd, preflight);
    store.appendEvent(lockedOwnerRun.id, action === "undo" ? "workspace_changes_undone" : "workspace_changes_reapplied", {
      scope: "workflow",
      workflowId: workflow.id,
      runIds: lockedContext.patchRuns.map((item) => item.run.id),
      recoveryId,
      cwd: lockedCwd,
      approvalIds: lockedContext.patchRuns.flatMap((item) => item.patchSet.approvals.map((approval) => approval.id)),
      rawPatchSha256: lockedPlans.map((plan) => plan.rawPatchSha256),
      touchedPaths: preflight.paths,
      summary: summarizePatchPlans(lockedPlans),
    });
    return buildWorkflowWorkspaceChangesResponse(store, workflow);
  });
}

export async function buildWorkflowWorkspaceChangesResponse(
  store: RunStore,
  workflow: ChannelWorkflow,
): Promise<WorkflowWorkspaceChangesResponse> {
  const context = buildWorkflowRecoveryContext(store, workflow);
  const plans = context.patchRuns.flatMap((item) => item.patchSet.plans);
  const files = summarizePatchFiles(plans);
  const summary = summarizePatchPlans(plans);
  const base = {
    cwd: context.cwd ?? context.runs[0]?.cwd ?? store.paths.cwd,
    workflowId: workflow.id,
    runIds: context.patchRuns.map((item) => item.run.id),
    files,
    summary,
    updatedAt: workflow.updatedAt,
  } as const;
  if (context.unavailableReason || !context.ownerRun || !context.cwd) {
    return {
      ...base,
      state: "unavailable",
      canUndo: false,
      canReapply: false,
      unavailableReason: context.unavailableReason ?? "No successfully applied reversible patch records were found.",
    };
  }

  const observation = observeWorkflowRecoveryState(
    context.cwd,
    workflow.id,
    plans,
    workflowRecoveryEvents(store, context.ownerRun.id, workflow.id),
  );
  const updatedAt = observation.updatedAt ?? workflow.updatedAt;
  if (observation.conflict) {
    return { ...base, updatedAt, state: "conflicted", canUndo: false, canReapply: false, unavailableReason: observation.conflict };
  }
  try {
    const action: RecoveryAction = observation.state === "undone" ? "reapply" : "undo";
    await preflightRecoveryPlanSequence(context.cwd, workflowRecoveryPlanSteps(context.patchRuns, action));
    return {
      ...base,
      updatedAt,
      state: observation.state,
      canUndo: observation.state === "applied",
      canReapply: observation.state === "undone",
    };
  } catch (error) {
    return {
      ...base,
      updatedAt,
      state: "conflicted",
      canUndo: false,
      canReapply: false,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveWorkflowStore(
  storeRegistry: RunStoreRegistry,
  workflowId: string,
  cwd?: string,
): { readonly store: RunStore; readonly workflow: ChannelWorkflow } | undefined {
  const store = storeRegistry.findStoreForWorkflow(workflowId, cwd);
  const workflow = store?.getChannelWorkflow(workflowId);
  return store && workflow ? { store, workflow } : undefined;
}

function buildWorkflowRecoveryContext(store: RunStore, workflow: ChannelWorkflow): WorkflowRecoveryContext {
  const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 });
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const explicitRunIds = new Set(steps.map((step) => step.runId).filter((runId): runId is string => Boolean(runId)));
  const runs = store.listRuns({ limit: 10_000 })
    .filter((run) => explicitRunIds.has(run.id) || Boolean(run.workflowStepId && stepById.has(run.workflowStepId)))
    .sort((left, right) => compareWorkflowRuns(left, right, stepById));

  if (!isTerminalWorkflow(workflow)) {
    return { workflow, runs, patchRuns: [], unavailableReason: "The workflow is still active." };
  }
  if (runs.some((run) => !isTerminalRun(run))) {
    return { workflow, runs, patchRuns: [], unavailableReason: "A workflow run is still active." };
  }

  const patchRuns: WorkflowPatchRun[] = [];
  for (const run of runs) {
    const patchSet = collectRunPatchSet(store, run.id);
    if (patchSet.plans.length === 0) {
      continue;
    }
    let allowedWritePathSets: readonly (readonly string[])[];
    try {
      allowedWritePathSets = readAllowedWritePathSets(store, run);
    } catch (error) {
      return {
        workflow,
        runs,
        patchRuns,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
    patchRuns.push({
      run,
      stepPosition: run.workflowStepId ? stepById.get(run.workflowStepId)?.position ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
      patchSet,
      planAppliedAt: patchPlanAppliedTimes(store, run, patchSet),
      allowedWritePathSets,
    });
  }
  if (patchRuns.length === 0) {
    return { workflow, runs, patchRuns, unavailableReason: "No successfully applied reversible patch records were found." };
  }
  const cwd = patchRuns[0]?.run.cwd;
  if (!cwd || patchRuns.some((item) => resolvePath(item.run.cwd) !== resolvePath(cwd))) {
    return { workflow, runs, patchRuns, unavailableReason: "Workflow recovery cannot span multiple execution directories." };
  }
  return { workflow, runs, patchRuns, ownerRun: patchRuns.at(-1)?.run, cwd };
}

function assertWorkflowRecoveryAvailable(context: WorkflowRecoveryContext): void {
  if (context.unavailableReason || !context.ownerRun || !context.cwd) {
    throw new RunWorkspaceRecoveryError(409, "workspace_changes_unavailable", context.unavailableReason ?? "Workflow recovery is unavailable.");
  }
}

function workflowRecoveryPlanSteps(
  patchRuns: readonly WorkflowPatchRun[],
  action: RecoveryAction,
): readonly RecoveryPlanStep[] {
  const forward = patchRuns.flatMap((item) => item.patchSet.plans.map((plan, planIndex) => ({
    plan,
    allowedWritePathSets: item.allowedWritePathSets,
    appliedAt: item.planAppliedAt[planIndex] ?? item.run.endedAt ?? item.run.createdAt,
    stepPosition: item.stepPosition,
    runCreatedAt: item.run.createdAt,
    runId: item.run.id,
    planIndex,
  }))).sort((left, right) =>
    left.appliedAt.localeCompare(right.appliedAt) ||
    left.stepPosition - right.stepPosition ||
    left.runCreatedAt.localeCompare(right.runCreatedAt) ||
    left.runId.localeCompare(right.runId) ||
    left.planIndex - right.planIndex
  );
  return action === "undo"
    ? [...forward].reverse().map((step) => ({ plan: invertPatchPlan(step.plan), allowedWritePathSets: step.allowedWritePathSets }))
    : forward.map((step) => ({ plan: step.plan, allowedWritePathSets: step.allowedWritePathSets }));
}

function patchPlanAppliedTimes(
  store: RunStore,
  run: RunSession,
  patchSet: RunPatchSet,
): readonly string[] {
  const toolEndAtByCallId = new Map<string, string>();
  for (const event of listAllRunEvents(store, run.id)) {
    if (event.type !== "tool_end" || !isRecord(event.data) || event.data.isError === true || typeof event.data.toolCallId !== "string") {
      continue;
    }
    toolEndAtByCallId.set(event.data.toolCallId, event.ts);
  }
  return patchSet.approvals.map((approval) =>
    approval.toolCallId ? toolEndAtByCallId.get(approval.toolCallId) ?? approval.resolvedAt ?? run.endedAt ?? run.createdAt : run.endedAt ?? run.createdAt
  );
}

function workflowRecoveryEvents(
  store: RunStore,
  ownerRunId: string,
  workflowId: string,
): readonly RunEventEnvelope[] {
  return listAllRunEvents(store, ownerRunId).filter((event) =>
    (event.type === "workspace_change_recovery_started" || event.type === "workspace_changes_undone" || event.type === "workspace_changes_reapplied") &&
    isRecord(event.data) && event.data.scope === "workflow" && event.data.workflowId === workflowId
  );
}

function observeWorkflowRecoveryState(
  cwd: string,
  workflowId: string,
  plans: readonly PatchPlan[],
  events: readonly RunEventEnvelope[],
): WorkflowRecoveryObservation {
  const completed = [...events].reverse().find((event) => event.type === "workspace_changes_undone" || event.type === "workspace_changes_reapplied");
  const completedState = completed?.type === "workspace_changes_undone" ? "undone" : "applied";
  const pending = [...events].reverse().find((event) => event.type === "workspace_change_recovery_started" && event.seq > (completed?.seq ?? 0));
  if (!pending) {
    return { state: completedState, updatedAt: completed?.ts };
  }
  const intent = readWorkflowRecoveryIntent(pending.data, workflowId, plans);
  if (!intent) {
    return { state: completedState, updatedAt: pending.ts, conflict: "The latest workflow recovery intent is invalid and requires manual review." };
  }
  try {
    const hashes = new Map(intent.files.map((file) => [file.path, hashRecoveryContent(readWorkspaceTextFile(cwd, file.path))] as const));
    if (intent.files.every((file) => hashes.get(file.path) === file.afterSha256)) {
      return { state: intent.action === "undo" ? "undone" : "applied", updatedAt: pending.ts };
    }
    if (intent.files.every((file) => hashes.get(file.path) === file.beforeSha256)) {
      return { state: completedState, updatedAt: pending.ts };
    }
    return {
      state: completedState,
      updatedAt: pending.ts,
      conflict: "Workflow recovery was interrupted after changing only part of the recorded files. Review the workspace before retrying.",
    };
  } catch (error) {
    return { state: completedState, updatedAt: pending.ts, conflict: error instanceof Error ? error.message : String(error) };
  }
}

function readWorkflowRecoveryIntent(
  data: unknown,
  workflowId: string,
  plans: readonly PatchPlan[],
): WorkflowRecoveryIntent | undefined {
  if (!isRecord(data) || data.scope !== "workflow" || data.workflowId !== workflowId ||
    (data.action !== "undo" && data.action !== "reapply") || typeof data.recoveryId !== "string" || !Array.isArray(data.files)) {
    return undefined;
  }
  const expectedPaths = new Set(uniquePaths(plans.flatMap((plan) => plan.touchedPaths)));
  const files: RecoveryIntentFile[] = [];
  const seen = new Set<string>();
  for (const item of data.files) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.beforeSha256 !== "string" || typeof item.afterSha256 !== "string" ||
      !expectedPaths.has(item.path) || seen.has(item.path)) {
      return undefined;
    }
    seen.add(item.path);
    files.push({ path: item.path, beforeSha256: item.beforeSha256, afterSha256: item.afterSha256 });
  }
  return files.length === expectedPaths.size && files.length > 0
    ? { action: data.action, recoveryId: data.recoveryId, files }
    : undefined;
}

function compareWorkflowRuns(
  left: RunSession,
  right: RunSession,
  stepById: ReadonlyMap<string, ChannelWorkflowStep>,
): number {
  const leftPosition = left.workflowStepId ? stepById.get(left.workflowStepId)?.position ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const rightPosition = right.workflowStepId ? stepById.get(right.workflowStepId)?.position ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isTerminalWorkflow(workflow: ChannelWorkflow): boolean {
  return workflow.status === "succeeded" || workflow.status === "failed" || workflow.status === "cancelled";
}
