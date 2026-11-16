import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSqliteWorkflowIsolationStore, normalizeWorkflowIntegrationRoundInputs, resolveStoragePaths,
  workflowIsolationDigest, workflowIsolationSafetyFingerprint, workflowIsolationScopePlanDigest,
  workflowIsolationStepSafetyFingerprint,
  type RunStore, type WorkflowIntegrationRound, type WorkflowIntegrationRoundInputsV1,
  type WorkflowIsolationMutationResult, type WorkflowIsolationScopePlanV1,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { createWorkflowSafetyAdmission, createWorkflowSafetyPlan, workflowSafetySnapshot } from "../runs/workflow-safety.js";
import { assertChannelWorkspaceReady } from "./workspace.js";
import { assertWorkflowRepositoryRunAllowed, withWorkflowRepositoryFence }
  from "../workspaces/workflow-repository-fence.js";
import {
  assertWorkflowGitWorktreeBudget, inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest,
  type WorkflowGitWorktreeScope,
} from "../workspaces/workflow-git-repository.js";

export interface PlanWorkflowIsolatedRoundInput {
  readonly store: RunStore;
  /** Explicit Host selection, not a template field or a public Run request. */
  readonly workflowId: string;
  readonly roundId: string;
  readonly validationRequirements: WorkflowIntegrationRoundInputsV1["validationRequirements"];
  readonly templatePins?: WorkflowIntegrationRoundInputsV1["templatePins"];
  readonly optionalFailurePolicy?: WorkflowIntegrationRoundInputsV1["optionalFailurePolicy"];
  /** Host delivery selection, frozen before start; target application still requires its own approval. */
  readonly mode?: WorkflowIntegrationRoundInputsV1["mode"];
  /** Explicit Host-only opt-in; declarations and the readonly channel switch do not grant it. */
  readonly parallelExecution?: WorkflowIntegrationRoundInputsV1["parallelExecution"];
  /** Tests/Host bootstrap may choose an owned root; never supplied by the model. */
  readonly worktreeRoot?: string;
  readonly now?: string;
}

function accepted<T>(result: WorkflowIsolationMutationResult<T>): T {
  if ("value" in result) return result.value;
  throw new HttpError(409, result.code, "The isolated workflow plan changed or cannot be frozen.");
}

function blocked(message: string): never { throw new HttpError(409, "workflow_isolation_plan_unavailable", message); }

/** Freeze every writing participant before the first approval. No worktree, Task, Run or dispatch is created. */
export async function planWorkflowIsolatedRound(input: PlanWorkflowIsolatedRoundInput): Promise<{
  readonly round: WorkflowIntegrationRound;
  readonly plans: readonly WorkflowIsolationScopePlanV1[];
}> {
  const { store } = input;
  const workflow = store.getChannelWorkflow(input.workflowId), channel = workflow && store.getChannel(workflow.channelId);
  if (!workflow || !channel || !workflow.metadata?.workflowGraphFingerprint) blocked("An accepted workflow graph and channel are required.");
  const workspace = assertChannelWorkspaceReady(channel, store.paths.cwd);
  if (!workspace.ok || workspace.executionCwd !== store.paths.cwd) blocked("This profile requires the channel's canonical repository checkout.");
  const allSteps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
  const steps = allSteps
    .filter(step => step.metadata?.sideEffectClass === "workspace_write")
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (steps.length === 0 || steps.length > 128) blocked("The selected workflow has no bounded writing participants.");
  const parallelExecution = input.parallelExecution;
  if (parallelExecution && (parallelExecution.profile !== "isolated_siblings_v1"
    || parallelExecution.writeLockScope !== "boundPath" || channel.runtimePolicy.writeLockScope !== "boundPath"
    || !Number.isSafeInteger(parallelExecution.maxConcurrentSteps) || parallelExecution.maxConcurrentSteps < 2
    || parallelExecution.maxConcurrentSteps > 4 || parallelExecution.maxConcurrentSteps > steps.length
    || channel.runtimePolicy.maxConcurrentRuns < parallelExecution.maxConcurrentSteps
    || (workflow.metadata.maxParallelSteps ?? channel.runtimePolicy.maxConcurrentRuns) < parallelExecution.maxConcurrentSteps
    || steps.some(step => step.metadata?.parallelPolicy?.autoParallel !== true
      || (step.metadata.parallelPolicy.maxParallelSiblings ?? 1) < parallelExecution.maxConcurrentSteps
      || (step.metadata.maxParallelSiblings ?? parallelExecution.maxConcurrentSteps) < parallelExecution.maxConcurrentSteps))) {
    blocked("Isolated sibling execution requires an explicit bounded file group and boundPath write locking.");
  }
  for (const step of steps) {
    if (step.taskId || step.runId || step.metadata?.startOwner || !["queued", "waiting_for_approval"].includes(step.status)
      || step.metadata?.preStepApprovalId && !step.metadata.isolationScopePlan) blocked("Isolation must be selected before approval or start.");
  }
  const hostStateRoot = store.paths.stateLocation === "repo-local" ? store.paths.rootDir : undefined;
  const repository = await inspectWorkflowGitRepository(store.paths.cwd, { hostStateRoot });
  // Writing scopes survive until round completion, so budget every participant plus integration, not just concurrent slots.
  await assertWorkflowGitWorktreeBudget(repository.root, steps.length + 1);
  const worktreeRoot = input.worktreeRoot ?? resolveStoragePaths(store.paths.cwd, { workspaceStateLocation: "user-data-dir" }).workspace.worktreesDir;
  if (!input.worktreeRoot) await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  if (await realpath(worktreeRoot) !== worktreeRoot) blocked("The Host worktree root must be canonical.");
  const scopeFor = (stepId: string) => planWorkflowGitWorktree({ repository, worktreeRoot, roundId: input.roundId,
    stepId, generation: 1, worktreeId: workflowIsolationDigest({ roundId: input.roundId, stepId, generation: 1 }, "wiw_") });
  const integration = await scopeFor("integration");
  const scopes: WorkflowGitWorktreeScope[] = [];
  for (const step of steps) scopes.push(await scopeFor(step.id));
  const observed = await inspectWorkflowGitRepository(store.paths.cwd, { hostStateRoot });
  const assertUnchanged = () => {
    if (!isDeepStrictEqual(store.getChannelWorkflow(workflow.id), workflow)
      || !isDeepStrictEqual(store.getChannel(channel.id), channel)
      || !isDeepStrictEqual(store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true }), allSteps)) {
      blocked("The workflow changed during isolation planning.");
    }
  };
  if (workflowGitRepositoryBasisDigest(observed) !== workflowGitRepositoryBasisDigest(repository)) {
    blocked("The repository changed during isolation planning.");
  }
  assertUnchanged();

  const prepared = steps.map((step, index) => {
    const scope = scopes[index]!;
    const safetyPlan = createWorkflowSafetyPlan({ store, step, workspaceCwd: repository.root,
      executionCwd: scope.executionRoot, runnerId: step.metadata?.requestedRunnerId, isolatedScope: scope });
    if (!safetyPlan || safetyPlan.profile !== "pi_host_isolated_files_v1") blocked("The Host isolated-files profile is unavailable.");
    if (step.metadata?.safetyPlan && !isDeepStrictEqual(step.metadata.safetyPlan, safetyPlan)) {
      blocked("An existing approved safety plan cannot be promoted to isolated execution.");
    }
    const plannedStep = { ...step, metadata: { ...step.metadata, safetyPlan } };
    const resourcePlan = createWorkflowSafetyAdmission(store, plannedStep, { workflowSafetySnapshot: workflowSafetySnapshot(safetyPlan),
      providerPresetId: step.metadata?.providerPresetId ?? channel.defaultProviderPresetId, runnerId: "pi" }, parallelExecution);
    if (!resourcePlan) blocked("Isolation planning requires resolved Provider and Runner capacity.");
    return { step: plannedStep, scope, resourcePlan };
  });
  const safetyPins = prepared.map(({ step }) => ({ workflowStepId: step.id, fingerprint: workflowIsolationStepSafetyFingerprint(step) }));
  const target = { executionRoot: repository.root, worktreeId: workflowIsolationDigest({ root: repository.root }, "wit_"),
    branchRef: repository.branchRef, expectedHead: repository.head, cleanStateDigest: workflowGitRepositoryBasisDigest(repository),
    inputMode: "clean_checkout" as const };
  const inputs = normalizeWorkflowIntegrationRoundInputs({ schemaVersion: 1, workflowId: workflow.id,
    canonicalWorkspaceId: workflow.workspaceId, canonicalWorkspaceRoot: repository.root,
    repositoryIdentity: { commonDir: repository.commonDir, objectFormat: repository.head.length === 40 ? "sha1" : "sha256" },
    target, baseCommit: repository.head, integration: location(integration), graphFingerprint: workflow.metadata.workflowGraphFingerprint,
    safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), templatePins: input.templatePins ?? [],
    participants: prepared.map(({ step }) => ({ workflowStepId: step.id, position: step.position,
      required: true })), mergeOrder: prepared.map(({ step }) => step.id),
    optionalFailurePolicy: input.optionalFailurePolicy ?? "require_success", validationRequirements: input.validationRequirements,
    mode: input.mode ?? "candidate_only", ...(parallelExecution ? { parallelExecution } : {}) });
  if (!inputs) blocked("The Host isolation requirements are invalid.");
  const plans = prepared.map(({ step, scope, resourcePlan }) => {
    const fields: Omit<WorkflowIsolationScopePlanV1, "planDigest"> = { schemaVersion: 1,
      planId: workflowIsolationDigest({ roundId: input.roundId, stepId: step.id, generation: 1 }, "wip_"),
      workflowId: workflow.id, workflowStepId: step.id, canonicalWorkspaceId: workflow.workspaceId,
      canonicalWorkspaceRoot: repository.root, repositoryIdentity: inputs.repositoryIdentity, target,
      integrationRoundId: input.roundId, generation: 1, stepGeneration: 1, baseCommit: repository.head,
      ...location(scope), graphFingerprint: inputs.graphFingerprint, safetyFingerprint: workflowIsolationStepSafetyFingerprint(step),
      templatePins: inputs.templatePins, resourcePlan };
    return { ...fields, planDigest: workflowIsolationScopePlanDigest(fields) };
  });
  const now = input.now ?? new Date().toISOString(), isolation = createSqliteWorkflowIsolationStore(store);
  const freeze = async () => {
    await assertWorkflowGitWorktreeBudget(repository.root, steps.length + 1);
    assertUnchanged();
    return accepted(isolation.freezePlan({ roundId: input.roundId, inputs, plans,
      safetyPlans: prepared.map(({ step }) => step.metadata.safetyPlan!),
      expectedWorkflow: workflow, expectedChannel: channel, expectedSteps: allSteps, now }));
  };
  if (parallelExecution) return withWorkflowRepositoryFence(store, input.roundId, inputs, freeze);
  assertWorkflowRepositoryRunAllowed(store, { cwd: repository.root });
  return freeze();
}

/** Rebuild only the preallocated scope; this is not creation or authority to run. */
export async function readWorkflowIsolationWorktreeScope(store: RunStore, pin: { readonly planId: string; readonly planDigest: string }): Promise<WorkflowGitWorktreeScope> {
  const plan = createSqliteWorkflowIsolationStore(store).getScopePlan(pin.planId);
  if (!plan || plan.planDigest !== pin.planDigest || plan.canonicalWorkspaceRoot !== store.paths.cwd) blocked("The isolated scope plan is missing or changed.");
  const repository = await inspectWorkflowGitRepository(plan.canonicalWorkspaceRoot,
    { hostStateRoot: store.paths.stateLocation === "repo-local" ? store.paths.rootDir : undefined });
  if (workflowGitRepositoryBasisDigest(repository) !== plan.target.cleanStateDigest) blocked("The target repository basis changed after planning.");
  const scope = await planWorkflowGitWorktree({ repository, worktreeRoot: dirname(plan.executionRoot),
    roundId: plan.integrationRoundId, stepId: plan.workflowStepId, generation: plan.stepGeneration, worktreeId: plan.worktreeId });
  if (scope.executionRoot !== plan.executionRoot || scope.branchRef !== plan.branchRef || scope.baseCommit !== plan.baseCommit) {
    blocked("The reconstructed isolated location differs from the approved plan.");
  }
  return scope;
}

function location(scope: WorkflowGitWorktreeScope) {
  return { executionRoot: scope.executionRoot, worktreeId: scope.worktreeId, branchRef: scope.branchRef };
}
