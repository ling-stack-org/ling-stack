import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowIsolationStore,
  createSqliteWorkflowWorktreeCleanupStore,
  workflowIsolationDigest, workflowIsolationRecord as record,
  type RunStore, type WorkflowIntegrationCoordinatorStore, type WorkflowIntegrationRound,
  type WorkflowIntegrationRoundInputsV1, type WorkflowIsolationExecutionBinding,
  type WorkflowIsolationScopePlanV1,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { readIntegrationArtifact } from "../channels/workflow-integration-journal.js";
import { workflowGit } from "./managed-worktrees.js";
import {
  inspectWorkflowGitRepository, planWorkflowGitWorktree, workflowGitRepositoryBasisDigest,
  type WorkflowGitWorktreeReceipt, type WorkflowGitWorktreeScope,
} from "./workflow-git-repository.js";

interface Registration { readonly path: string; readonly fields: ReadonlyMap<string, string> }
interface RetainedCheckout {
  readonly scope: WorkflowGitWorktreeScope;
  readonly receipt: WorkflowGitWorktreeReceipt;
  readonly proofDigest: string;
}
const requireRetained: (condition: unknown) => asserts condition = condition => {
  if (!condition) throw new Error("workflow_repository_retained_checkout_unverified");
};

/** Read-only inventory, never adoption, capture, cleanup or renewed execution authority. */
export async function verifyWorkflowRepositoryCheckouts(store: RunStore, inputs: WorkflowIntegrationRoundInputsV1,
  inventory: Buffer): Promise<void> {
  try {
    const entries = registrations(inventory), canonical = entries[0];
    requireRetained(canonical?.path === inputs.canonicalWorkspaceRoot && !canonical.fields.has("bare")
      && !canonical.fields.has("detached") && canonical.fields.get("branch") === inputs.target.branchRef
      && canonical.fields.get("HEAD") === inputs.target.expectedHead);
    if (entries.length === 1) return;
    const isolation = createSqliteWorkflowIsolationStore(store), coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
    const cleanup = createSqliteWorkflowWorktreeCleanupStore(store);
    // Core release is necessary, but its durable retired record is not a fresh source/effect check.
    const retired = coordinator.listRounds().filter(round => round.inputs.parallelExecution
      && round.inputs.canonicalWorkspaceRoot === inputs.canonicalWorkspaceRoot
      && round.inputs.canonicalWorkspaceId === inputs.canonicalWorkspaceId
      && round.inputs.repositoryIdentity.commonDir === inputs.repositoryIdentity.commonDir
      && isolation.reconcileParallelParentFence({ roundId: round.roundId, generation: round.generation,
        now: new Date().toISOString() }).status === "released");
    const read = (): readonly RetainedCheckout[] => store.readSnapshot(() => {
      requireRetained(store.paths.cwd === inputs.canonicalWorkspaceRoot);
      const result: RetainedCheckout[] = [];
      for (const previous of retired) {
        const round = isolation.getIntegrationRound(previous.roundId), workflow = store.getChannelWorkflow(previous.inputs.workflowId);
        requireRetained(round && isDeepStrictEqual(round, previous) && workflow && ["succeeded", "failed", "cancelled"].includes(workflow.status)
          && !round.openIntentId && !round.outstandingApprovalId && !coordinator.readPublicationBlocker(workflow.id));
        // Cleanup has a separate effect journal; even an observed intent is not reusable ownership.
        requireRetained(cleanup.listIntents({ workflowId: workflow.id }).length === 0);
        const steps = store.listChannelWorkflowSteps({ workflowId: workflow.id, complete: true });
        requireRetained(steps.every(step => ["succeeded", "failed", "cancelled", "skipped"].includes(step.status)));
        const bindings = new Map<string, WorkflowIsolationExecutionBinding>();
        for (const participant of round.inputs.participants) {
          const step = steps.find(value => value.id === participant.workflowStepId), pin = step?.metadata?.isolationScopePlan;
          requireRetained(step && pin);
          const plan = isolation.getScopePlan(pin.planId);
          requireRetained(plan && plan.planDigest === pin.planDigest && plan.workflowId === workflow.id
            && plan.integrationRoundId === round.roundId && plan.generation === round.generation
            && plan.workflowStepId === step.id && plan.canonicalWorkspaceRoot === inputs.canonicalWorkspaceRoot
            && plan.canonicalWorkspaceId === inputs.canonicalWorkspaceId
            && isDeepStrictEqual(plan.repositoryIdentity, inputs.repositoryIdentity));
          if (!step.runId) {
            requireRetained(["cancelled", "skipped"].includes(step.status) && !step.taskId && !step.metadata?.startOwner);
            continue;
          }
          // Discover the Host binding from retained creation evidence, never a path/name convention.
          const artifacts = store.listArtifacts(step.runId).filter(artifact => {
            const payload = artifact.sealedPayload;
            return record(payload) && payload.kind === "workflow_isolation_worktree" && payload.planId === plan.planId;
          });
          requireRetained(artifacts.length === 1);
          const artifact = artifacts[0]!, payload = artifact.sealedPayload;
          requireRetained(record(payload));
          const writer = payload.writer as WorkflowIsolationExecutionBinding["fence"] & { readonly bindingId: string };
          const binding = writer && isolation.getExecutionBinding(writer.bindingId);
          requireRetained(binding && binding.planId === plan.planId && binding.planDigest === plan.planDigest
            && binding.runId === step.runId && isDeepStrictEqual(writer, { bindingId: binding.bindingId, ...binding.fence }));
          const stopped = isolation.inspectStoppedExecution({ writer, expectedRevision: binding.revision, now: new Date().toISOString() });
          requireRetained(stopped.status === "stopped" && isDeepStrictEqual(stopped.binding, binding)
            && isDeepStrictEqual(stopped.plan, plan));
          requireReleasedResources(store, binding, plan);
          bindings.set(step.id, binding);
          const creation = isolation.getReceipt(binding.creationReceiptId!), intent = creation && isolation.getIntent(creation.intentId);
          const scope = payload.scope as unknown as WorkflowGitWorktreeScope, receipt = payload.receipt as unknown as WorkflowGitWorktreeReceipt;
          requireRetained(scope && scope.repository && receipt);
          const location = { executionRoot: plan.executionRoot, worktreeId: plan.worktreeId,
            branchRef: plan.branchRef, commonDir: plan.repositoryIdentity.commonDir };
          requireRetained(creation?.outcome === "confirmed" && creation.artifactId === artifact.id
            && intent?.status === "confirmed" && intent.kind === "worktree_create"
            && isDeepStrictEqual(intent.scope, { type: "binding", bindingId: binding.bindingId })
            && isDeepStrictEqual(intent.writer, writer) && isDeepStrictEqual(binding.location,
              { executionRoot: plan.executionRoot, worktreeId: plan.worktreeId, branchRef: plan.branchRef })
            && isDeepStrictEqual(intent.before, { ...location, exists: false, headCommit: null })
            && isDeepStrictEqual(intent.after, creation.observed) && isDeepStrictEqual(payload.observed, creation.observed)
            && isDeepStrictEqual(creation.observed, { ...location, exists: true, headCommit: plan.baseCommit, tree: intent.after.tree })
            && typeof intent.after.tree === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(intent.after.tree)
            && intent.after.tree.length === plan.baseCommit.length
            && payload.schemaVersion === 1 && payload.intentId === intent.intentId && payload.planDigest === plan.planDigest
            && artifact.runId === binding.runId && artifact.type === "json" && artifact.sealedPayloadState !== "pruned"
            && scope.roundId === plan.integrationRoundId && scope.stepId === plan.workflowStepId && scope.generation === plan.stepGeneration
            && scope.executionRoot === plan.executionRoot && scope.worktreeId === plan.worktreeId
            && scope.branchRef === plan.branchRef && scope.baseCommit === plan.baseCommit
            && scope.repository.root === plan.canonicalWorkspaceRoot && scope.repository.commonDir === plan.repositoryIdentity.commonDir
            && scope.repository.head === plan.baseCommit && scope.repository.head === plan.target.expectedHead
            && scope.repository.branchRef === plan.target.branchRef
            && workflowGitRepositoryBasisDigest(scope.repository) === plan.target.cleanStateDigest
            && isDeepStrictEqual(receipt, { ...location, baseCommit: plan.baseCommit,
              rootDevice: receipt.rootDevice, rootInode: receipt.rootInode })
            && [receipt.rootDevice, receipt.rootInode].every(value => typeof value === "string" && /^\d+$/u.test(value)));
          result.push({ scope, receipt, proofDigest: stopped.proofDigest });
        }
        const integration = readRetainedIntegrationCheckout(store, coordinator, round, bindings);
        if (integration) result.push(integration);
      }
      return result;
    });
    const before = read();
    for (const entry of entries.slice(1)) {
      const matches = before.filter(value => value.scope.executionRoot === entry.path);
      requireRetained(matches.length === 1);
      await verifyPhysical(matches[0]!, entry, entries);
    }
    requireRetained(isDeepStrictEqual(read(), before));
    requireRetained((await workflowGit(inputs.canonicalWorkspaceRoot, ["worktree", "list", "--porcelain", "-z"])).stdout.equals(inventory));
    requireRetained(isDeepStrictEqual(read(), before));
  } catch (cause) {
    const error = new HttpError(409, "workflow_repository_checkouts_unsupported",
      "This isolated parallel profile requires a repository without other checkouts.");
    error.cause = cause;
    throw error;
  }
}

/** Immutable historical ownership only; never reacquire coordinator publication authority. */
function readRetainedIntegrationCheckout(store: RunStore, coordinator: WorkflowIntegrationCoordinatorStore,
  round: WorkflowIntegrationRound, bindings: ReadonlyMap<string, WorkflowIsolationExecutionBinding>): RetainedCheckout | undefined {
  // These readers verify retained hashes, original writer fences and immutable journal links.
  const effects = coordinator.listEffects(round), receipts = coordinator.listReceipts(round);
  if (!effects.length) { requireRetained(!receipts.length); return undefined; }
  const creations = effects.filter(effect => effect.effectKey === "worktree:create");
  const binding = bindings.get(round.inputs.mergeOrder[0]!);
  requireRetained(creations.length === 1 && binding && bindings.size === round.inputs.participants.length
    && round.writerBindingId === binding.bindingId && !round.openIntentId && !round.outstandingApprovalId
    && effects.every(effect => effect.status === "confirmed" && isDeepStrictEqual(effect.writer,
      { bindingId: binding.bindingId, ...binding.fence })));
  const creation = creations[0]!, confirmed = receipts.filter(receipt => receipt.intentId === creation.intentId && receipt.outcome === "confirmed");
  requireRetained(creation.kind === "integration_create" && isDeepStrictEqual(creation.scope,
    { type: "round", roundId: round.roundId, generation: round.generation }) && confirmed.length === 1);
  const observation = confirmed[0]!, payload = readIntegrationArtifact(store, creation.payloadArtifactId, binding.runId);
  const evidence = readIntegrationArtifact(store, observation.artifactId, binding.runId).evidence;
  requireRetained(record(payload.effect) && payload.effect.kind === "workflow_integration_worktree"
    && record(payload.effect.scope) && record(evidence) && isDeepStrictEqual(evidence.scope, payload.effect.scope)
    && record(evidence.receipt));
  const scope = payload.effect.scope as unknown as WorkflowGitWorktreeScope;
  const receipt = evidence.receipt as unknown as WorkflowGitWorktreeReceipt;
  const { inputs } = round, repository = scope.repository;
  const location = { ...inputs.integration, commonDir: inputs.repositoryIdentity.commonDir };
  requireRetained(repository && scope.roundId === round.roundId && scope.stepId === "integration"
    && scope.generation === round.generation && scope.baseCommit === inputs.baseCommit
    && scope.executionRoot === location.executionRoot && scope.worktreeId === location.worktreeId && scope.branchRef === location.branchRef
    && repository.root === inputs.canonicalWorkspaceRoot && repository.root === inputs.target.executionRoot
    && repository.commonDir === location.commonDir && repository.head === inputs.baseCommit && repository.head === inputs.target.expectedHead
    && repository.head.length === (inputs.repositoryIdentity.objectFormat === "sha1" ? 40 : 64)
    && repository.branchRef === inputs.target.branchRef && (!repository.dirty || inputs.target.inputMode === "committed_head_only")
    && workflowGitRepositoryBasisDigest(repository) === inputs.target.cleanStateDigest
    && isDeepStrictEqual(creation.before, { ...location, exists: false, headCommit: null })
    && isDeepStrictEqual(creation.after, { ...location, exists: true, headCommit: inputs.baseCommit, tree: creation.after.tree })
    && typeof creation.after.tree === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(creation.after.tree)
    && creation.after.tree.length === inputs.baseCommit.length && isDeepStrictEqual(observation.observed, creation.after)
    && isDeepStrictEqual(receipt, { ...location, baseCommit: inputs.baseCommit, rootDevice: receipt.rootDevice, rootInode: receipt.rootInode })
    && [receipt.rootDevice, receipt.rootInode].every(value => typeof value === "string" && /^\d+$/u.test(value)));
  return { scope, receipt, proofDigest: workflowIsolationDigest({ effects, receipts }) };
}

function requireReleasedResources(store: RunStore, binding: WorkflowIsolationExecutionBinding, plan: WorkflowIsolationScopePlanV1): void {
  const leases = store.listResourceLeases({ resourceType: "workflow_step", resourceKey: plan.workflowStepId, limit: 1000 });
  requireRetained(leases.length < 1000 && leases.some(lease => lease.id === binding.startOwner.leaseId
    && lease.ownerType === "workflow_step" && lease.ownerId === plan.workflowStepId && lease.status === "released" && lease.releasedAt)
    && leases.every(lease => lease.status === "released" && !!lease.releasedAt));
  const owned = store.listResourceLeases({ attemptId: binding.fence.attemptId, limit: 1000 });
  const slots = store.listRuntimeSemaphoreSlots({ workUnitId: binding.fence.workUnitId, limit: 1000 });
  requireRetained(owned.length < 1000 && owned.every(lease => lease.status === "released" && !!lease.releasedAt)
    && slots.length < 1000 && slots.every(slot => slot.status === "released" && !!slot.releasedAt));
}

async function verifyPhysical(target: RetainedCheckout, entry: Registration, entries: readonly Registration[]): Promise<void> {
  const { scope, receipt } = target, expected = scope.repository;
  requireRetained(isDeepStrictEqual(await planWorkflowGitWorktree(scope), scope)
    && !["locked", "prunable", "bare", "detached"].some(key => entry.fields.has(key))
    && entry.fields.get("branch") === scope.branchRef && entry.fields.get("HEAD") === scope.baseCommit
    && entries.filter(value => value.fields.get("branch") === scope.branchRef).length === 1);
  const root = await lstat(scope.executionRoot, { bigint: true });
  requireRetained(root.isDirectory() && !root.isSymbolicLink() && await realpath(scope.executionRoot) === scope.executionRoot
    && String(root.dev) === receipt.rootDevice && String(root.ino) === receipt.rootInode);
  const common = await lstat(expected.commonDir, { bigint: true });
  requireRetained(common.isDirectory() && !common.isSymbolicLink() && await realpath(expected.commonDir) === expected.commonDir
    && String(common.dev) === expected.commonDevice && String(common.ino) === expected.commonInode);
  const canonical = await inspectWorkflowGitRepository(expected.root, { allowDirtyCandidate: true, hostStateRoot: expected.hostState?.root });
  requireRetained(workflowGitRepositoryBasisDigest(expected) === workflowGitRepositoryBasisDigest({ ...canonical,
    head: expected.head, dirty: expected.dirty }));
  const checkout = await inspectWorkflowGitRepository(scope.executionRoot, { allowDirtyCandidate: true });
  requireRetained(checkout.commonDir === expected.commonDir && checkout.commonDevice === expected.commonDevice
    && checkout.commonInode === expected.commonInode && checkout.head === scope.baseCommit && checkout.branchRef === scope.branchRef
    && checkout.rootDevice === receipt.rootDevice && checkout.rootInode === receipt.rootInode
    && dirname(checkout.gitDir) === join(expected.commonDir, "worktrees")
    && await realpath(checkout.gitDir) === checkout.gitDir && (await lstat(checkout.gitDir)).isDirectory());
  const dotGit = join(scope.executionRoot, ".git");
  requireRetained(await metadataText(dotGit) === `gitdir: ${checkout.gitDir}\n`
    && await metadataText(join(checkout.gitDir, "gitdir")) === `${dotGit}\n`);
  const ref = (await workflowGit(expected.root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)", scope.branchRef])).stdout;
  requireRetained(decode(ref) === `${scope.branchRef}\0${scope.baseCommit}\0commit\0\n`);
}

function registrations(bytes: Buffer): readonly Registration[] {
  const text = decode(bytes);
  requireRetained(text.endsWith("\0\0"));
  const entries = text.slice(0, -2).split("\0\0").map(record => {
    const fields = new Map<string, string>();
    for (const field of record.split("\0")) {
      const split = field.indexOf(" "), key = split < 0 ? field : field.slice(0, split), value = split < 0 ? "" : field.slice(split + 1);
      requireRetained(["worktree", "HEAD", "branch", "bare", "detached", "locked", "prunable"].includes(key) && !fields.has(key));
      fields.set(key, value);
    }
    const path = fields.get("worktree");
    requireRetained(path && isAbsolute(path));
    return { path, fields };
  });
  requireRetained(new Set(entries.map(entry => entry.path)).size === entries.length);
  return entries;
}

async function metadataText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    requireRetained(stat.isFile() && stat.nlink === 1 && stat.size <= 16384);
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    requireRetained(count === stat.size);
    return decode(bytes.subarray(0, count));
  } finally { await file.close(); }
}
function decode(bytes: Buffer): string { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
