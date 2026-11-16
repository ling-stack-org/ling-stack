import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { createSqliteWorkflowIsolationStore, createSqliteWorkflowIntegrationCoordinatorStore, createSqliteWorkflowMergeApprovalStore,
  type RunStore, type WorkflowIntegrationRound, type WorkflowIsolationGitIdentity,
  type WorkflowIntegrationCoordinatorEffect } from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";
import { workflowGit } from "../workspaces/managed-worktrees.js";
import { createWorkflowGitWorktree, inspectWorkflowGitRepository, planWorkflowGitWorktree,
  reconcileWorkflowGitWorktree, workflowGitRefExists, workflowGitRepositoryBasisDigest,
  type WorkflowGitWorktreeScope, type WorkflowGitWorktreeReceipt } from "../workspaces/workflow-git-repository.js";
import { inspectSealedWorkflowBranchResult, workflowGitPacketDigest, workflowGitPacketJson, workflowGitResultRef,
  type WorkflowBranchResult, type WorkflowBranchResultPacketV1, type WorkflowGitRefEffect } from "./workflow-branch-result.js";
import { createWorkflowIntegrationCandidate, type WorkflowIntegrationCandidateContext,
  type WorkflowIntegrationCandidateResult, type WorkflowIntegrationCandidatePacketV1 } from "./workflow-integration-candidate.js";
import { validateWorkflowIntegrationCandidate, workflowCandidateValidationRequirementsDigest } from "./workflow-candidate-validation.js";
import { createWorkflowIntegrationJournal, integrationValue, readIntegrationArtifact, requireIntegration,
  retainIntegrationArtifact, WorkflowIntegrationCoordinatorError, type WorkflowIntegrationJournal } from "./workflow-integration-journal.js";
import { runWorkflowIsolationOperation } from "./workflow-isolation-lifecycle.js";
import { reconcileWorkflowMergeApplication } from "./workflow-merge-apply.js";
import { requestWorkflowMergeApproval } from "./workflow-merge-approval.js";

export interface WorkflowIntegrationCoordinationResult {
  readonly status: "waiting" | "awaiting_approval" | "applied" | "conflicted" | "blocked" | "failed";
  readonly round: WorkflowIntegrationRound;
  readonly code?: string;
}
const same = (a: unknown, b: unknown) => workflowGitPacketJson(a) === workflowGitPacketJson(b);

export async function reconcileWorkflowIntegrations(store: RunStore, workflowId: string,
  now?: () => string): Promise<readonly WorkflowIntegrationCoordinationResult[]> {
  if (!store.listChannelWorkflowSteps({ workflowId, complete: true }).some(step => step.metadata?.isolationScopePlan)) return [];
  const rounds = createSqliteWorkflowIntegrationCoordinatorStore(store).listRounds(workflowId);
  const results: WorkflowIntegrationCoordinationResult[] = [];
  for (const { roundId } of rounds) {
    const result = await coordinateWorkflowIntegration({ store, roundId, now });
    if (result.status === "awaiting_approval" && result.round.inputs.mode === "apply_to_target"
      && !result.round.outstandingApprovalId) {
      const proposal = await requestWorkflowMergeApproval({ store, roundId, now });
      if (!("value" in proposal)) {
        results.push({ status: "blocked", round: result.round, code: proposal.code });
        continue;
      }
    }
    results.push(result);
  }
  return results;
}

/** Host integration coordinator. Existing apply permits are observed only; no model dispatch or cleanup. */
export async function coordinateWorkflowIntegration(input: { readonly store: RunStore; readonly roundId: string;
  readonly now?: () => string }): Promise<WorkflowIntegrationCoordinationResult> {
  const initial = createSqliteWorkflowIsolationStore(input.store).getIntegrationRound(input.roundId);
  requireIntegration(initial, "workflow_integration.round_missing");
  return runWorkflowIsolationOperation(input.store, initial.inputs.workflowId, `integration:${input.roundId}`,
    () => coordinateWorkflowIntegrationInner(input));
}

async function coordinateWorkflowIntegrationInner(input: Parameters<typeof coordinateWorkflowIntegration>[0]): Promise<WorkflowIntegrationCoordinationResult> {
  const { store } = input, now = input.now ?? (() => new Date().toISOString());
  const isolation = createSqliteWorkflowIsolationStore(store), coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
  const initial = isolation.getIntegrationRound(input.roundId);
  requireIntegration(initial, "workflow_integration.round_missing");
  const latest = () => isolation.getIntegrationRound(initial.roundId)!;
  try {
    if (store.getChannelWorkflow(initial.inputs.workflowId)?.status === "succeeded") {
      const blocker = coordinator.readPublicationBlocker(initial.inputs.workflowId)
        ?? coordinator.readCompletionBlocker(initial.inputs.workflowId);
      requireIntegration(!blocker, blocker ?? "workflow_integration.completion_unverified");
      return { status: initial.inputs.mode === "candidate_only" ? "awaiting_approval" : "applied", round: initial };
    }
    if (initial.inputs.mode === "apply_to_target" && ["awaiting_approval", "applying", "applied", "blocked"].includes(initial.phase)) {
      const request = createSqliteWorkflowMergeApprovalStore(store).getRequest(initial.roundId, initial.generation);
      if (request) {
        const result = await reconcileWorkflowMergeApplication({ store, approvalId: request.approvalId, now });
        return { status: result.status === "applied" ? "applied" : result.status === "waiting" ? "awaiting_approval" : "blocked",
          round: result.round, code: result.code };
      }
      if (initial.phase === "awaiting_approval") return { status: "awaiting_approval", round: initial };
    }
    const steps = initial.inputs.participants.map(participant => store.getChannelWorkflowStep(participant.workflowStepId));
    if (steps.some(step => step && !["succeeded", "failed", "cancelled", "skipped"].includes(step.status))) {
      return { status: "waiting", round: latest() };
    }
    const authority = coordinator.assertAuthority({ roundId: initial.roundId, generation: initial.generation, now: now() });
    if (authority.status !== "authorized") throw new WorkflowIntegrationCoordinatorError(authority.code);
    const branchResults: WorkflowBranchResult[] = authority.participants.map(({ binding, resultIntent }) => {
      const packet = readIntegrationArtifact(store, resultIntent.packetArtifactId, binding.runId) as unknown as WorkflowBranchResultPacketV1;
      requireIntegration(workflowGitPacketDigest(packet) === resultIntent.packetDigest, "workflow_integration.branch_packet_changed");
      return { status: "sealed", packet, packetDigest: resultIntent.packetDigest, commit: resultIntent.commit,
        tree: resultIntent.tree, resultRef: resultIntent.ref };
    });
    const repository = await inspectWorkflowGitRepository(initial.inputs.canonicalWorkspaceRoot,
      { allowDirtyCandidate: initial.inputs.target.inputMode === "committed_head_only",
        hostStateRoot: store.paths.stateLocation === "repo-local" ? store.paths.rootDir : undefined });
    requireIntegration(workflowGitRepositoryBasisDigest(repository) === initial.inputs.target.cleanStateDigest,
      "workflow_integration.repository_changed");
    for (const branch of branchResults) await inspectSealedWorkflowBranchResult(repository.root, branch);
    const scope = await planWorkflowGitWorktree({ repository, worktreeRoot: dirname(initial.inputs.integration.executionRoot),
      roundId: initial.roundId, stepId: "integration", generation: initial.generation, worktreeId: initial.inputs.integration.worktreeId });
    requireIntegration(scope.executionRoot === initial.inputs.integration.executionRoot && scope.branchRef === initial.inputs.integration.branchRef
      && scope.baseCommit === initial.inputs.baseCommit, "workflow_integration.scope_changed");
    const tree = (await workflowGit(repository.root, ["rev-parse", "--verify", `${scope.baseCommit}^{tree}`])).stdout.toString("utf8").trim();
    const identity: WorkflowIsolationGitIdentity = { ...initial.inputs.integration, commonDir: repository.commonDir,
      exists: true, headCommit: scope.baseCommit, tree };
    const journal = createWorkflowIntegrationJournal({ store, coordinator, authority, identity, now });
    const receipts = () => coordinator.listReceipts({ roundId: initial.roundId, generation: initial.generation });
    const advance = (to: WorkflowIntegrationRound["phase"], extra: { readonly reason?: string;
      readonly candidate?: WorkflowIntegrationRound["candidate"]; readonly candidateArtifactId?: string } = {}) => {
      const read = journal.current();
      return integrationValue(coordinator.advanceRound({ roundId: read.round.roundId, generation: read.round.generation,
        expectedRevision: read.round.revision, authorityDigest: read.authorityDigest, from: read.round.phase, to,
        receiptIds: receipts().filter(receipt => receipt.outcome === "confirmed").map(receipt => receipt.receiptId), ...extra, now: now() }));
    };
    if (initial.phase === "preparing") advance("collecting");
    const receipt = await integrationWorktree(scope, identity, journal, store);
    if (latest().phase === "collecting") advance("integrating");
    const context: WorkflowIntegrationCandidateContext = { roundId: initial.roundId, generation: initial.generation,
      inputs: initial.inputs, inputsDigest: initial.inputsDigest, writer: authority.writer, repository,
      integrationScope: scope, integrationReceipt: receipt, branchResults };
    const assertContext = (observed: WorkflowIntegrationCandidateContext) => {
      journal.current();
      requireIntegration(same(observed, context), "workflow_integration.context_changed");
    };
    const priorEffects = journal.effects().filter(effect => effect.effectKey !== "worktree:create");
    let candidate: WorkflowIntegrationCandidateResult;
    if (priorEffects.length) {
      await reconcileIntegrationRefs(priorEffects, context, journal, store);
      const sealed = priorEffects.find(effect => effect.effectKey.endsWith("/candidate") || effect.effectKey.endsWith("/conflict"));
      requireIntegration(sealed, "workflow_integration.candidate_requires_reconciliation");
      const payload = readIntegrationArtifact(store, sealed.payloadArtifactId, journal.runId);
      requireIntegration(isRecord(payload.effect) && typeof payload.effect.packetJson === "string", "workflow_integration.candidate_packet_missing");
      const packet = JSON.parse(payload.effect.packetJson) as WorkflowIntegrationCandidatePacketV1;
      requireIntegration(same(packet.context, context) && workflowGitPacketDigest(packet) === payload.effect.packetDigest,
        "workflow_integration.candidate_packet_changed");
      candidate = { status: packet.status, applied: false, packet, packetDigest: workflowGitPacketDigest(packet),
        commit: packet.commit, tree: packet.tree, resultRef: packet.resultRef };
    } else {
      requireIntegration(latest().phase === "integrating", "workflow_integration.phase_changed");
      candidate = await createWorkflowIntegrationCandidate({ ...context, assertCurrentAuthority: assertContext, journal: journal.journal });
    }
    const candidateArtifactId = retainIntegrationArtifact(store, journal.runId, { ...candidate.packet }, "Workflow integration candidate", now());
    if (candidate.status === "conflicted") {
      if (latest().phase === "integrating") advance("conflicted", { reason: "workflow_integration.text_conflict" });
      return { status: "conflicted", round: latest(), code: "workflow_integration.text_conflict" };
    }
    if (latest().phase === "integrating") advance("verifying");
    const verificationIdentity = { ...identity, headCommit: candidate.commit, tree: candidate.tree };
    const existing = journal.effects().find(effect => effect.effectKey === "candidate:verify");
    if (existing) {
      requireIntegration(existing.status === "confirmed", "workflow_integration.verification_requires_reconciliation");
      const observation = receipts().find(receipt => receipt.intentId === existing.intentId && receipt.outcome === "confirmed");
      requireIntegration(observation, "workflow_integration.verification_receipt_missing");
      const retained = readIntegrationArtifact(store, observation.artifactId, journal.runId);
      requireIntegration(isRecord(retained.evidence) && retained.evidence.kind === "workflow_candidate_verification",
        "workflow_integration.verification_packet_changed");
      const verification = retained.evidence;
      if (verification.status !== "passed") {
        if (latest().phase === "verifying") advance("failed", { reason: "workflow_integration.validation_failed" });
        return { status: "failed", round: latest(), code: "workflow_integration.validation_failed" };
      }
      if (latest().phase === "verifying") advance("awaiting_approval", { candidateArtifactId, candidate: {
        commit: candidate.commit, tree: candidate.tree, packetDigest: candidate.packetDigest,
        branchResultDigests: branchResults.map(result => result.packetDigest), validationDigest: workflowGitPacketDigest(verification) } });
    } else {
      requireIntegration(latest().phase === "verifying", "workflow_integration.phase_changed");
      const effect = journal.record("candidate:verify", "candidate_verify", verificationIdentity, verificationIdentity,
        { kind: "workflow_candidate_verify", candidate: { packetDigest: candidate.packetDigest, commit: candidate.commit,
          tree: candidate.tree, resultRef: candidate.resultRef }, validationRequirements: initial.inputs.validationRequirements,
        requirementsDigest: workflowCandidateValidationRequirementsDigest(initial.inputs.validationRequirements) });
      const verification = await validateWorkflowIntegrationCandidate({ candidate, validationRequirements: initial.inputs.validationRequirements,
        assertCurrentAuthority: observed => {
          assertContext({ roundId: observed.roundId, generation: observed.generation, inputs: observed.inputs,
            inputsDigest: observed.inputsDigest, writer: observed.writer, repository: observed.repository,
            integrationScope: observed.integrationScope, integrationReceipt: observed.integrationReceipt, branchResults: observed.branchResults });
          requireIntegration(observed.candidatePacketDigest === candidate.packetDigest && observed.candidateCommit === candidate.commit
            && observed.candidateTree === candidate.tree && observed.candidateResultRef === candidate.resultRef,
          "workflow_integration.verification_candidate_changed");
        } });
      journal.receipt(effect.intentId, "confirmed", verificationIdentity, { ...verification.packet });
      if (verification.status !== "passed") {
        advance("failed", { reason: "workflow_integration.validation_failed" });
        return { status: "failed", round: latest(), code: "workflow_integration.validation_failed" };
      }
      advance("awaiting_approval", { candidateArtifactId, candidate: { commit: candidate.commit, tree: candidate.tree,
        packetDigest: candidate.packetDigest, branchResultDigests: branchResults.map(result => result.packetDigest),
        validationDigest: verification.packetDigest } });
    }
    return { status: "awaiting_approval", round: latest() };
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string"
      ? cause.code : "workflow_integration.coordination_unverified";
    return { status: "blocked", round: latest(), code };
  }
}

async function integrationWorktree(scope: WorkflowGitWorktreeScope, identity: WorkflowIsolationGitIdentity,
  journal: WorkflowIntegrationJournal, store: RunStore): Promise<WorkflowGitWorktreeReceipt> {
  let effect = journal.effects().find(entry => entry.effectKey === "worktree:create");
  const exists = await pathExists(scope.executionRoot);
  let fresh = false;
  if (!effect) {
    requireIntegration(!exists && !await workflowGitRefExists(scope.repository.root, scope.branchRef), "workflow_integration.foreign_worktree");
    effect = journal.record("worktree:create", "integration_create", { ...identity, exists: false, headCommit: null, tree: undefined },
      identity, { kind: "workflow_integration_worktree", scope });
    fresh = true;
  }
  const payload = readIntegrationArtifact(store, effect.payloadArtifactId, journal.runId);
  requireIntegration(isRecord(payload.effect) && same(payload.effect.scope, scope), "workflow_integration.worktree_scope_changed");
  journal.current();
  if (!exists && !fresh) throw new WorkflowIntegrationCoordinatorError("workflow_integration.worktree_effect_unconfirmed");
  const receipt = exists ? await reconcileWorkflowGitWorktree(scope)
    : await createWorkflowGitWorktree(scope, { beforeCreate: () => { journal.current(); } });
  journal.current();
  if (effect.status !== "confirmed") journal.receipt(effect.intentId, "confirmed", identity, { scope, receipt });
  requireIntegration((await workflowGit(scope.executionRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).stdout.length === 0,
  "workflow_integration.worktree_dirty");
  journal.current();
  return receipt;
}

/** Reopen observes exact retained refs only; a missing computation/ref is never rerun here. */
async function reconcileIntegrationRefs(effects: readonly WorkflowIntegrationCoordinatorEffect[], context: WorkflowIntegrationCandidateContext,
  journal: WorkflowIntegrationJournal, store: RunStore): Promise<void> {
  for (const effect of effects.filter(entry => entry.effectKey.startsWith("ref:"))) {
    const payload = readIntegrationArtifact(store, effect.payloadArtifactId, journal.runId);
    requireIntegration(isRecord(payload.effect), "workflow_integration.ref_payload_changed");
    const ref = payload.effect as unknown as WorkflowGitRefEffect;
    requireIntegration(effect.effectKey === `ref:${ref.ref}` && ref.roundId === context.roundId && ref.generation === context.generation
      && ref.commonDir === context.repository.commonDir && ref.kind === "integration_create", "workflow_integration.ref_identity_changed");
    const observedCommit = await workflowGitResultRef(context.repository.root, ref.ref);
    journal.current();
    requireIntegration(observedCommit === ref.afterCommit, "workflow_integration.ref_unconfirmed");
    requireIntegration((await workflowGit(context.repository.root, ["rev-parse", "--verify", `${observedCommit}^{tree}`])).stdout.toString("utf8").trim() === ref.tree,
      "workflow_integration.ref_tree_changed");
    if (effect.status !== "confirmed") journal.receipt(effect.intentId, "confirmed", effect.after,
      { intentId: effect.intentId, effect: ref, outcome: "confirmed", observedCommit });
  }
  requireIntegration(journal.effects().filter(effect => effect.kind === "integrate_branch").every(effect => effect.status === "confirmed"),
    "workflow_integration.merge_requires_reconciliation");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
