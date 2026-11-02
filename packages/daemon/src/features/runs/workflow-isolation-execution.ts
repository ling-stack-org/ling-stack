import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type {
  BindWorkflowIsolationExecutionInput, RunStore, WorkflowIsolationExecutionBinding,
  WorkflowIsolationGitIdentity, WorkflowIsolationIntent, WorkflowIsolationMutationResult,
  WorkflowIsolationScopePlanV1, WorkflowIsolationStore, WorkflowIsolationWriter,
} from "@ling-stack/core";
import { workflowGit } from "../workspaces/managed-worktrees.js";
import {
  createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree,
  reconcileWorkflowGitWorktree, workflowGitRefExists, workflowGitRepositoryBasisDigest,
  type WorkflowGitWorktreeReceipt, type WorkflowGitWorktreeScope,
} from "../workspaces/workflow-git-repository.js";

export class WorkflowIsolationExecutionError extends Error {
  constructor(readonly code: string) { super(code); }
}

type PreparationStore = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getHostAttemptCompletion"
  | "listEvents" | "listHarnessToolExecutions" | "listHostOperationBlockers" | "getArtifact" | "createArtifact">;

export interface WorkflowIsolatedExecution {
  readonly binding: WorkflowIsolationExecutionBinding;
  readonly plan: WorkflowIsolationScopePlanV1;
  readonly writer: WorkflowIsolationWriter;
  readonly scope: WorkflowGitWorktreeScope;
  readonly receipt: WorkflowGitWorktreeReceipt;
}

export interface PrepareWorkflowIsolatedExecutionInput {
  readonly store: PreparationStore;
  readonly isolation: WorkflowIsolationStore;
  readonly binding: Omit<BindWorkflowIsolationExecutionInput, "now">;
  /** Host-preallocated identity. This is not supplied by a model or a public Run request. */
  readonly scope: WorkflowGitWorktreeScope;
  readonly now?: () => string;
  readonly assertCurrent?: () => void;
}

const requireExecution: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new WorkflowIsolationExecutionError(code);
};

function accepted<T>(result: WorkflowIsolationMutationResult<T>): T {
  if ("value" in result) return result.value;
  throw new WorkflowIsolationExecutionError(result.code);
}

/** Prepare only: no Runner dispatch, admission transfer, tool execution, merge permit or cleanup. */
export async function ensureWorkflowIsolationWorktree(input: PrepareWorkflowIsolatedExecutionInput): Promise<WorkflowIsolatedExecution> {
  const scope = structuredClone(input.scope), requested = structuredClone(input.binding);
  const now = input.now ?? (() => new Date().toISOString());
  const isolation = input.isolation, store = input.store;
  const writer: WorkflowIsolationWriter = { bindingId: requested.bindingId, ...requested.fence };
  const plan = isolation.getScopePlan(requested.planId);
  requireExecution(plan && plan.planDigest === requested.planDigest, "workflow_isolation.execution_plan_mismatch");
  assertScope(plan, scope);
  const replanned = await planWorkflowGitWorktree(scope);
  requireExecution(isDeepStrictEqual(replanned, scope), "workflow_isolation.execution_scope_mismatch");
  accepted(isolation.bindExecution({ ...requested, now: now() }));

  const current = (): WorkflowIsolationExecutionBinding => {
    requireExecution(input.assertCurrent?.() === undefined, "workflow_isolation.preparation_guard_invalid");
    const result = isolation.assertExecutionBinding({ writer, now: now(), requireReady: false });
    if (result.status !== "current") throw new WorkflowIsolationExecutionError(result.code);
    requireExecution(isDeepStrictEqual(result.plan, plan), "workflow_isolation.execution_plan_mismatch");
    assertNotDispatched(store, result.binding);
    return result.binding;
  };
  current();
  await assertTargetBasis(scope);
  current();
  const tree = (await workflowGit(scope.repository.root, ["rev-parse", "--verify", `${scope.baseCommit}^{tree}`])).stdout.toString("utf8").trim();
  requireExecution(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree) && tree.length === scope.baseCommit.length,
    "workflow_isolation.execution_tree_invalid");
  current();
  const before: WorkflowIsolationGitIdentity = { ...location(scope), exists: false, headCommit: null };
  const after: WorkflowIsolationGitIdentity = { ...location(scope), exists: true, headCommit: scope.baseCommit, tree };
  const id = createHash("sha256").update(JSON.stringify({ bindingId: writer.bindingId, planDigest: plan.planDigest, writer })).digest("hex");
  const intentId = `wice_${id}`, receiptId = `wicr_${id}`, artifactId = `wica_${id}`;
  let binding = current(), intent = isolation.getIntent(intentId);
  if (!intent) {
    requireExecution(binding.status === "planned" && !binding.openIntentId, "workflow_isolation.execution_not_planned");
    // A path/ref predating our durable intent is never adopted, even if it looks identical.
    requireExecution(!await exists(scope.executionRoot) && !await workflowGitRefExists(scope.repository.root, scope.branchRef),
      "workflow_isolation.execution_identity_exists");
    binding = current();
    intent = accepted(isolation.recordIntent({ intentId, commandId: intentId, scope: { type: "binding", bindingId: writer.bindingId },
      expectedRevision: binding.revision, writer, kind: "worktree_create", before, after, now: now() }));
  }
  assertIntent(intent, writer, before, after);
  requireExecution(intent.status === "pending" || intent.status === "confirmed", "workflow_isolation.execution_effect_unconfirmed");
  const intentCurrent = (): void => {
    const latest = current(), persisted = isolation.getIntent(intentId);
    requireExecution(persisted && isDeepStrictEqual(persisted, intent)
      && (intent!.status === "pending" ? latest.status === "planned" && latest.openIntentId === intentId
        : !latest.openIntentId), "workflow_isolation.execution_intent_changed");
  };
  intentCurrent();
  let receipt: WorkflowGitWorktreeReceipt;
  if (await exists(scope.executionRoot)) {
    receipt = await reconcileWorkflowGitWorktree(scope);
  } else {
    requireExecution(intent.status === "pending" && !await workflowGitRefExists(scope.repository.root, scope.branchRef),
      "workflow_isolation.execution_physical_identity_missing");
    intentCurrent();
    receipt = await createWorkflowGitWorktree(scope, { beforeCreate: intentCurrent });
  }
  intentCurrent();
  await assertTargetBasis(scope);
  intentCurrent();
  const payload = { schemaVersion: 1, kind: "workflow_isolation_worktree", intentId,
    planId: plan.planId, planDigest: plan.planDigest, writer, scope, receipt, observed: after };
  let artifact = store.getArtifact(artifactId);
  if (artifact) {
    requireExecution(artifact.runId === requested.runId && artifact.sealedPayloadState !== "pruned"
      && artifact.contentSha256 && isDeepStrictEqual(artifact.sealedPayload, payload), "workflow_isolation.execution_artifact_changed");
  } else {
    requireExecution(intent.status === "pending", "workflow_isolation.execution_artifact_missing");
    artifact = store.createArtifact({ id: artifactId, runId: requested.runId, type: "json", path: `sqlite:${artifactId}`,
      title: "Workflow isolated worktree creation", contentType: "application/json", sealedPayload: payload, createdAt: now() });
  }
  intentCurrent();
  if (intent.status === "pending") {
    accepted(isolation.recordReceipt({ receiptId, intentId, expectedRevision: current().revision, writer,
      outcome: "confirmed", observed: after, artifactId: artifact.id, now: now() }));
  }
  const confirmed = isolation.getReceipt(receiptId);
  requireExecution(confirmed?.intentId === intentId && confirmed.outcome === "confirmed"
    && confirmed.artifactId === artifact.id && isDeepStrictEqual(confirmed.observed, after), "workflow_isolation.execution_receipt_changed");
  binding = current();
  if (binding.status === "planned") {
    binding = accepted(isolation.markExecutionReady({ commandId: `wicready_${id}`, writer,
      expectedRevision: binding.revision, creationReceiptId: receiptId, now: now() }));
  }
  requireExecution(binding.status === "ready" && !binding.openIntentId && binding.creationReceiptId === receiptId,
    "workflow_isolation.execution_not_ready");
  return { binding, plan, writer, scope, receipt };
}

/** SDK preparation happens after the physical receipt; only Core can atomically seal both requests. */
export async function prepareWorkflowIsolatedExecution(input: PrepareWorkflowIsolatedExecutionInput & {
  readonly prepareInput: (execution: WorkflowIsolatedExecution) => Promise<Readonly<Record<string, unknown>>>;
}): Promise<WorkflowIsolatedExecution & { readonly runnerExecutionInput: Readonly<Record<string, unknown>> }> {
  const execution = await ensureWorkflowIsolationWorktree(input);
  const now = input.now ?? (() => new Date().toISOString());
  const runnerExecutionInput = await input.prepareInput(execution);
  requireExecution(input.assertCurrent?.() === undefined, "workflow_isolation.preparation_guard_invalid");
  await reconcileWorkflowGitWorktree(execution.scope);
  await assertTargetBasis(execution.scope);
  const result = input.isolation.assertExecutionBinding({ writer: execution.writer, now: now(), requireReady: false });
  if (result.status !== "current") throw new WorkflowIsolationExecutionError(result.code);
  assertNotDispatched(input.store, result.binding);
  const binding = accepted(input.isolation.sealPreparedExecution({ writer: execution.writer,
    expectedRevision: result.binding.revision, runnerExecutionInput, now: now() }));
  return { ...execution, binding, runnerExecutionInput };
}

function assertScope(plan: WorkflowIsolationScopePlanV1, scope: WorkflowGitWorktreeScope): void {
  const repository = scope.repository;
  requireExecution(scope.roundId === plan.integrationRoundId && scope.stepId === plan.workflowStepId
    && scope.generation === plan.stepGeneration && scope.worktreeId === plan.worktreeId
    && scope.executionRoot === plan.executionRoot && scope.branchRef === plan.branchRef && scope.baseCommit === plan.baseCommit
    && repository.root === plan.canonicalWorkspaceRoot && repository.root === plan.target.executionRoot
    && repository.commonDir === plan.repositoryIdentity.commonDir && repository.head === plan.target.expectedHead
    && repository.head === plan.baseCommit && repository.branchRef === plan.target.branchRef
    && repository.head.length === (plan.repositoryIdentity.objectFormat === "sha1" ? 40 : 64)
    && (!repository.dirty || plan.target.inputMode === "committed_head_only")
    && workflowGitRepositoryBasisDigest(repository) === plan.target.cleanStateDigest, "workflow_isolation.execution_scope_mismatch");
}

async function assertTargetBasis(scope: WorkflowGitWorktreeScope): Promise<void> {
  const observed = await inspectWorkflowGitRepository(scope.repository.root, { allowDirtyCandidate: scope.repository.dirty,
    hostStateRoot: scope.repository.hostState?.root });
  requireExecution(workflowGitRepositoryBasisDigest(observed) === workflowGitRepositoryBasisDigest(scope.repository),
    "workflow_isolation.execution_target_changed");
}

function assertNotDispatched(store: PreparationStore, binding: WorkflowIsolationExecutionBinding): void {
  const run = store.getRun(binding.runId), unit = store.getWorkUnit(binding.fence.workUnitId), attempt = store.getWorkUnitAttempt(binding.fence.attemptId);
  requireExecution(run?.status === "queued" && !run.startedAt && !run.endedAt && unit && ["queued", "claimed"].includes(unit.status)
    && !unit.startedAt && !unit.endedAt && !unit.lastHeartbeatAt && attempt?.status === "created"
    && !attempt.startedAt && !attempt.endedAt && !attempt.abortRequestedAt && !attempt.lastHeartbeatAt
    && attempt.effectiveRunnerId === "pi", "workflow_isolation.preparation_already_started");
  const source = { runId: binding.runId, ...binding.fence };
  requireExecution(!store.getHostAttemptCompletion(source) && !store.listHostOperationBlockers(source).length
    && !store.listHarnessToolExecutions(binding.runId).length
    && !store.listEvents(binding.runId).some(event => ["tool_start", "tool_end", "host_command_prepared", "host_command_settled"].includes(event.type)),
    "workflow_isolation.preparation_already_started");
}

function assertIntent(intent: WorkflowIsolationIntent, writer: WorkflowIsolationWriter,
  before: WorkflowIsolationGitIdentity, after: WorkflowIsolationGitIdentity): void {
  requireExecution(intent.kind === "worktree_create" && intent.scope.type === "binding" && intent.scope.bindingId === writer.bindingId
    && isDeepStrictEqual(intent.writer, writer) && isDeepStrictEqual(intent.before, before) && isDeepStrictEqual(intent.after, after),
    "workflow_isolation.execution_intent_changed");
}

function location(scope: WorkflowGitWorktreeScope) {
  return { executionRoot: scope.executionRoot, worktreeId: scope.worktreeId, branchRef: scope.branchRef, commonDir: scope.repository.commonDir };
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
