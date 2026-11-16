import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createSqliteWorkflowIsolationStore, type RunSession, type RunStore,
  type RuntimeAttemptFenceV1 } from "@ling-stack/core";
import type { HarnessMode } from "@ling-stack/contracts";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import type { HostFileMutationOperation } from "../../runtime/host-operation-effects.js";
import { isRecord } from "../../shared/validation.js";
import { readPreparedRunnerInput } from "./prepared-runner-input.js";
import { workflowSafetyEffectRejection } from "./workflow-safety.js";

export interface WorkflowIsolationFileAuthorityInput {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly mode: HarnessMode;
  readonly sourceFence?: RuntimeAttemptFenceV1;
  /** Host-only dispatch binding, never an SDK or public request capability. */
  readonly workflowIsolationBindingId?: string;
  readonly hostOperation?: HostFileMutationOperation;
  readonly signal?: AbortSignal;
}

export interface WorkflowIsolatedExecutionAuthorityInput {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly sourceFence: RuntimeAttemptFenceV1;
  /** Host-only dispatch identity, not a persistable permit. */
  readonly bindingId: string;
  readonly now?: string;
}

const requireAuthority: (condition: unknown, code: string) => asserts condition = (condition, code) => {
  if (!condition) throw new Error(code);
};

function isolationMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const safety = isRecord(value.workflowSafetySnapshot) ? value.workflowSafetySnapshot.plan : undefined;
  const prepared = isRecord(value.runnerExecutionInput) ? value.runnerExecutionInput.input : undefined;
  return value.workflowIsolationPlan !== undefined || isRecord(safety) && safety.profile === "pi_host_isolated_files_v1"
    || isRecord(prepared) && prepared.isolatedToolsProfile !== undefined;
}

function executionTask(value: unknown): PiRunnerApprovalRequest["task"] {
  requireAuthority(isRecord(value) && typeof value.id === "string" && typeof value.title === "string"
    && typeof value.prompt === "string" && (value.channelId === undefined || typeof value.channelId === "string"),
  "workflow_isolation_file_source_changed");
  // Durable snapshots may contain a full Task. The SDK captures only this semantic projection.
  return { id: value.id, title: value.title, prompt: value.prompt,
    ...(value.channelId === undefined ? {} : { channelId: value.channelId }) };
}

/** Missing dispatch authority must not turn persisted isolation into a legacy direct write. */
export function requiresWorkflowIsolationFileMutation(input: Pick<WorkflowIsolationFileAuthorityInput,
  "store" | "run" | "workflowIsolationBindingId">): boolean {
  const current = input.store.getRun(input.run.id);
  return input.workflowIsolationBindingId !== undefined || isolationMarker(input.run.requestSnapshot)
    || isolationMarker(current?.requestSnapshot) || [current?.workflowStepId, input.run.workflowStepId].some(id => {
      const metadata = id ? input.store.getChannelWorkflowStep(id)?.metadata : undefined;
      return metadata?.isolationScopePlan !== undefined || metadata?.safetyPlan?.profile === "pi_host_isolated_files_v1";
    });
}

/** Shared synchronous dispatch/read/write authority. This does not grant OS effect admission. */
export function assertWorkflowIsolatedExecutionAuthority(input: WorkflowIsolatedExecutionAuthorityInput) {
  return input.store.readSnapshot(() => {
    requireAuthority(typeof input.bindingId === "string" && input.bindingId.length > 0,
      "workflow_isolation_file_binding_required");
    requireAuthority(input.sourceFence, "workflow_isolation_file_source_fence_required");
    const { store, sourceFence } = input;
    const run = store.getRun(input.run.id);
    requireAuthority(run && ["queued", "running", "waiting_for_approval"].includes(run.status)
      && store.isCurrentRunExecutionOwner(run.id, sourceFence)
      && (["taskId", "cwd", "workflowStepId", "channelId", "teammateId", "workUnitId"] as const)
        .every(key => run[key] === input.run[key]), "workflow_isolation_file_source_changed");
    const isolation = createSqliteWorkflowIsolationStore(store);
    const writer = { bindingId: input.bindingId, ...sourceFence };
    const current = isolation.assertExecutionBinding({ writer, now: input.now ?? new Date().toISOString(), requireReady: true });
    if (current.status !== "current") throw new Error(current.code);
    const { binding, plan } = current;
    const pin = { planId: plan.planId, planDigest: plan.planDigest };
    const snapshot = isRecord(run.requestSnapshot) ? run.requestSnapshot : undefined;
    const original = isRecord(input.run.requestSnapshot) ? input.run.requestSnapshot : undefined;
    const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
    requireAuthority(binding.runId === run.id && isDeepStrictEqual(binding.fence, sourceFence)
      && binding.location.executionRoot === plan.executionRoot && run.cwd === plan.executionRoot
      && step?.metadata?.safetyPlan?.profile === "pi_host_isolated_files_v1"
      && isDeepStrictEqual(step.metadata.isolationScopePlan, pin) && isDeepStrictEqual(snapshot?.workflowIsolationPlan, pin)
      && isDeepStrictEqual(original?.workflowIsolationPlan, pin), "workflow_isolation_file_plan_changed");
    const safety = workflowSafetyEffectRejection({ store, run: input.run,
      request: { toolName: "read", input: {}, cwd: run.cwd } });
    requireAuthority(!safety, safety ? `${safety.code}: ${safety.reason}` : "workflow_isolation_file_safety_changed");
    requireAuthority(isRecord(snapshot?.task) && snapshot.task.id === run.taskId, "workflow_isolation_file_source_changed");
    const prepared = readPreparedRunnerInput(snapshot.runnerExecutionInput, {
      cwd: run.cwd, task: executionTask(snapshot.task),
    });
    const unit = store.getWorkUnit(sourceFence.workUnitId);
    requireAuthority(prepared.input.isolatedToolsProfile === "host_isolated_files_v1"
      && isDeepStrictEqual([...(prepared.input.tools ?? [])].sort(), [...step.metadata.safetyPlan.tools].sort())
      && isDeepStrictEqual(original?.runnerExecutionInput, snapshot?.runnerExecutionInput)
      && isRecord(unit?.request) && isDeepStrictEqual(unit.request.runnerExecutionInput, snapshot?.runnerExecutionInput),
    "workflow_isolation_file_prepared_input_changed");
    const receipt = binding.creationReceiptId ? isolation.getReceipt(binding.creationReceiptId) : undefined;
    const intent = receipt ? isolation.getIntent(receipt.intentId) : undefined;
    const artifact = receipt ? store.getArtifact(receipt.artifactId) : undefined;
    const payload = artifact?.sealedPayload;
    requireAuthority(receipt?.outcome === "confirmed" && intent?.status === "confirmed" && intent.kind === "worktree_create"
      && intent.scope.type === "binding" && intent.scope.bindingId === binding.bindingId
      && isDeepStrictEqual(intent.writer, writer) && isDeepStrictEqual(intent.after, receipt.observed)
      && artifact?.runId === run.id && artifact.sealedPayloadState !== "pruned" && isRecord(payload)
      && artifact.contentSha256 === createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      && payload.schemaVersion === 1 && payload.kind === "workflow_isolation_worktree" && payload.intentId === intent.intentId
      && payload.planId === plan.planId && payload.planDigest === plan.planDigest && isDeepStrictEqual(payload.writer, writer)
      && isDeepStrictEqual(payload.observed, receipt.observed), "workflow_isolation_file_creation_evidence_changed");
    const scope = payload.scope, physical = payload.receipt;
    requireAuthority(isRecord(scope) && isRecord(scope.repository) && isRecord(physical)
      && scope.roundId === plan.integrationRoundId && scope.stepId === plan.workflowStepId && scope.generation === plan.stepGeneration
      && scope.executionRoot === plan.executionRoot && scope.worktreeId === plan.worktreeId && scope.branchRef === plan.branchRef
      && scope.baseCommit === plan.baseCommit && scope.repository.root === plan.canonicalWorkspaceRoot
      && scope.repository.commonDir === plan.repositoryIdentity.commonDir
      && physical.executionRoot === plan.executionRoot && physical.worktreeId === plan.worktreeId
      && physical.branchRef === plan.branchRef && physical.baseCommit === plan.baseCommit
      && physical.commonDir === plan.repositoryIdentity.commonDir && receipt.observed.exists
      && receipt.observed.executionRoot === plan.executionRoot && receipt.observed.worktreeId === plan.worktreeId
      && receipt.observed.branchRef === plan.branchRef && receipt.observed.headCommit === plan.baseCommit
      && receipt.observed.commonDir === plan.repositoryIdentity.commonDir, "workflow_isolation_file_creation_scope_changed");
    const root = plan.executionRoot, common = plan.repositoryIdentity.commonDir;
    requireAuthority(isAbsolute(root) && resolve(root) === root && realpathSync.native(root) === root
      && realpathSync.native(common) === common, "workflow_isolation_file_root_changed");
    const rootStat = lstatSync(root, { bigint: true }), commonStat = lstatSync(common, { bigint: true });
    requireAuthority(rootStat.isDirectory() && !rootStat.isSymbolicLink() && String(rootStat.dev) === physical.rootDevice
      && String(rootStat.ino) === physical.rootInode && commonStat.isDirectory() && !commonStat.isSymbolicLink()
      && String(commonStat.dev) === scope.repository.commonDevice && String(commonStat.ino) === scope.repository.commonInode,
    "workflow_isolation_file_root_changed");
    return { binding, plan, writer, receipt, artifact, root };
  });
}

/** File-specific requirements augment the same authority used by dispatch and read tools. */
export function assertWorkflowIsolationFileAuthority(input: WorkflowIsolationFileAuthorityInput) {
  input.signal?.throwIfAborted();
  requireAuthority(input.mode === "enforce", "workflow_isolation_file_enforce_required");
  requireAuthority(input.sourceFence, "workflow_isolation_file_source_fence_required");
  requireAuthority(typeof input.workflowIsolationBindingId === "string" && input.workflowIsolationBindingId.length > 0,
    "workflow_isolation_file_binding_required");
  requireAuthority(typeof input.hostOperation?.assertMayPrepare === "function"
    && typeof input.hostOperation.bindHarnessExecution === "function"
    && typeof input.hostOperation.effectGuard?.launch === "function", "workflow_isolation_file_host_operation_required");
  const current = assertWorkflowIsolatedExecutionAuthority({ store: input.store, run: input.run,
    sourceFence: input.sourceFence, bindingId: input.workflowIsolationBindingId });
  const request = input.request;
  const live = input.store.getRun(input.run.id), snapshot = input.run.requestSnapshot;
  requireAuthority(isRecord(snapshot) && isRecord(snapshot.harnessFeatureSnapshot)
    && snapshot.harnessFeatureSnapshot.toolBroker === "enforce" && isRecord(live?.requestSnapshot)
    && isRecord(live.requestSnapshot.harnessFeatureSnapshot) && live.requestSnapshot.harnessFeatureSnapshot.toolBroker === "enforce",
  "workflow_isolation_file_enforce_required");
  requireAuthority(live?.status === "running"
    && request.cwd === current.root && request.task.id === input.run.taskId
    && (request.toolName === "write" || request.toolName === "edit"), "workflow_isolation_file_source_changed");
  const prepared = readPreparedRunnerInput(snapshot.runnerExecutionInput, { cwd: request.cwd, task: executionTask(snapshot.task) });
  requireAuthority(prepared.input.tools?.includes(request.toolName)
    && prepared.preparedInput.tools.some(tool => tool.name === request.toolName), "workflow_isolation_file_prepared_input_changed");
  return current;
}

export function workflowIsolationFileMutationRejection(input: WorkflowIsolationFileAuthorityInput): string | undefined {
  if (!requiresWorkflowIsolationFileMutation(input)) return undefined;
  try { assertWorkflowIsolationFileAuthority(input); }
  catch (error) { return `workflow_isolation_file_denied: ${error instanceof Error ? error.message : String(error)}`; }
  return undefined;
}
