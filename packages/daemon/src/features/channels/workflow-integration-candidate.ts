import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest,
  type WorkflowIntegrationRoundInputsV1, type WorkflowIsolationWriter } from "@ling-stack/core";
import { workflowGit } from "../workspaces/managed-worktrees.js";
import { inspectWorkflowGitRepository, inspectWorkflowGitTree, reconcileWorkflowGitWorktree, safeWorkflowGitPath,
  withWorkflowGitRepositoryLock, workflowGitRepositoryBasisDigest, type WorkflowGitRepository,
  type WorkflowGitWorktreeReceipt, type WorkflowGitWorktreeScope } from "../workspaces/workflow-git-repository.js";
import { inspectSealedWorkflowBranchResult, sealWorkflowGitResultRef, workflowGitPacketDigest, workflowGitPacketJson,
  workflowGitPacketSnapshot, type WorkflowBranchResult, type WorkflowGitRefJournal } from "./workflow-branch-result.js";

export const WORKFLOW_INTEGRATION_POLICY = Object.freeze({ schemaVersion: 1, maxMergeOutputBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024, maxChangedBytes: 6 * 1024 * 1024, maxPatchBytes: 4 * 1024 * 1024, maxEntries: 10000 });

export class WorkflowIntegrationCandidateError extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface WorkflowIntegrationCandidateContext {
  readonly roundId: string;
  readonly generation: number;
  readonly inputs: WorkflowIntegrationRoundInputsV1;
  readonly inputsDigest: string;
  readonly writer: WorkflowIsolationWriter;
  readonly repository: WorkflowGitRepository;
  readonly integrationScope: WorkflowGitWorktreeScope;
  readonly integrationReceipt: WorkflowGitWorktreeReceipt;
  readonly branchResults: readonly WorkflowBranchResult[];
}

/** Host-only: check the persisted round/writer/fence, closed result set, accepted bindings and pins.
 * Neither a supplied digest nor this mechanism grants execution, verification or apply authority. */
export type AssertWorkflowIntegrationAuthority =
  (context: WorkflowIntegrationCandidateContext) => void | Promise<void>;

export interface WorkflowIntegrationMergeIntent {
  readonly roundId: string;
  readonly generation: number;
  readonly inputsDigest: string;
  readonly writer: WorkflowIsolationWriter;
  readonly commonDir: string;
  readonly sequence: number;
  readonly workflowStepId: string;
  readonly baseCommit: string;
  readonly oursCommit: string;
  readonly theirsCommit: string;
  readonly branchResultDigest: string;
  readonly resultRef: string;
}

export interface WorkflowIntegrationMergeEvidence extends WorkflowIntegrationMergeIntent {
  readonly exitCode: 0 | 1;
  readonly tree: string;
  readonly commit: string;
  readonly stages: readonly { readonly path: string; readonly mode: string; readonly blob: string; readonly stage: 1 | 2 | 3 }[];
  readonly messages: readonly { readonly paths: readonly string[]; readonly type: string; readonly message: string }[];
  readonly rawOutput: string;
  readonly rawOutputDigest: string;
  readonly patch: string;
  readonly patchDigest: string;
}

export interface WorkflowIntegrationGitJournal extends WorkflowGitRefJournal {
  /** Persist before merge-tree, outside an open SQLite transaction. */
  readonly recordMergeIntent: (effect: WorkflowIntegrationMergeIntent) => Promise<string>;
  /** Persist the complete evidence artifact before returning. Unknown effects require reconciliation. */
  readonly recordMergeReceipt: (receipt: { readonly intentId: string; readonly effect: WorkflowIntegrationMergeIntent;
    readonly outcome: "confirmed" | "blocked" | "effect_unknown"; readonly evidence?: WorkflowIntegrationMergeEvidence;
    readonly rawOutput?: string; readonly code?: string }) => Promise<void>;
}

export interface WorkflowIntegrationCandidatePacketV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_integration_candidate";
  readonly status: "pending_verification" | "conflicted";
  readonly applied: false;
  readonly context: WorkflowIntegrationCandidateContext;
  readonly policy: typeof WORKFLOW_INTEGRATION_POLICY;
  /** Inputs actually merged, including a conflicting input, never branches after the conflict. */
  readonly includedStepIds: readonly string[];
  readonly excludedResults: readonly { readonly workflowStepId: string; readonly packetDigest: string; readonly reason: "failed" | "cancelled" | "validation_failed" }[];
  readonly merges: readonly WorkflowIntegrationMergeEvidence[];
  readonly commit: string;
  readonly tree: string;
  readonly resultRef: string;
  readonly patch: string;
  readonly patchDigest: string;
}

export interface WorkflowIntegrationCandidateResult {
  readonly status: "pending_verification" | "conflicted";
  readonly applied: false;
  readonly packet: WorkflowIntegrationCandidatePacketV1;
  readonly packetDigest: string;
  readonly commit: string;
  readonly tree: string;
  readonly resultRef: string;
}

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);
const requireCandidate: (condition: unknown, code: string, details?: Readonly<Record<string, unknown>>) => asserts condition =
  (condition, code, details) => { if (!condition) throw new WorkflowIntegrationCandidateError(code, details); };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Candidate plumbing only. Frozen integration validation and a separate apply approval remain mandatory. */
export async function createWorkflowIntegrationCandidate(input: WorkflowIntegrationCandidateContext & {
  readonly assertCurrentAuthority: AssertWorkflowIntegrationAuthority;
  readonly journal: WorkflowIntegrationGitJournal;
}): Promise<WorkflowIntegrationCandidateResult> {
  const { assertCurrentAuthority, journal } = input;
  requireCandidate(typeof assertCurrentAuthority === "function", "workflow_integration_authority_required");
  requireCandidate([journal?.recordIntent, journal?.recordReceipt, journal?.recordMergeIntent, journal?.recordMergeReceipt]
    .every(callback => typeof callback === "function"), "workflow_integration_journal_required");
  const context = snapshotContext(input), { repository, inputs } = context, root = repository.root;
  const prefix = `refs/ling/workflow/candidates/${context.roundId}/${context.generation}-${context.integrationScope.worktreeId}`;
  const assertCurrent = async () => {
    requireCandidate(await assertCurrentAuthority(context) === undefined, "workflow_integration_authority_return_invalid");
    await inspectCurrentContext(context);
    for (const result of context.branchResults) await inspectSealedWorkflowBranchResult(root, result);
    requireCandidate(await assertCurrentAuthority(context) === undefined, "workflow_integration_authority_return_invalid");
  };
  return withWorkflowGitRepositoryLock(repository, async () => {
    await assertCurrent();
    requireCandidate((await workflowGit(root, ["for-each-ref", "--format=%(refname)", `${prefix}/`])).stdout.length === 0,
      "workflow_integration_generation_requires_reconciliation");
    const selected: WorkflowBranchResult[] = [], excludedResults: WorkflowIntegrationCandidatePacketV1["excludedResults"][number][] = [];
    for (const participant of inputs.participants) {
      const result = context.branchResults.find(branch => branch.packet.context.scope.stepId === participant.workflowStepId)!;
      const terminal = result.packet.terminal;
      if (terminal.outcome === "succeeded" && terminal.validations.every(validation => validation.exitCode === 0)) selected.push(result);
      else {
        requireCandidate(!participant.required && inputs.optionalFailurePolicy === "exclude_failed_with_evidence",
          "workflow_integration_unsuccessful_required_branch", { workflowStepId: participant.workflowStepId, packetDigest: result.packetDigest });
        excludedResults.push({ workflowStepId: participant.workflowStepId, packetDigest: result.packetDigest,
          reason: terminal.outcome === "succeeded" ? "validation_failed" : terminal.outcome });
      }
    }
    requireCandidate(selected.length > 0, "workflow_integration_no_successful_branch");
    await rejectCrossTreeAliases(root, [inputs.baseCommit, ...selected.map(result => result.tree)]);
    const allowedPaths = new Set(selected.flatMap(result => result.packet.changedPaths.map(change => change.path)));
    const merges: WorkflowIntegrationMergeEvidence[] = [];
    let ours = inputs.baseCommit, tree = await gitText(root, ["rev-parse", "--verify", `${ours}^{tree}`]);
    // Retain the generation even if a later journal fails before a merge result gets its own ref.
    const started = workflowGitPacketSnapshot({ schemaVersion: 1, kind: "workflow_integration_started", context,
      policy: WORKFLOW_INTEGRATION_POLICY, selectedStepIds: selected.map(result => result.packet.context.scope.stepId), excludedResults });
    await sealWorkflowGitResultRef(repository, { kind: "integration_create", roundId: context.roundId, generation: context.generation,
      commonDir: repository.commonDir, ref: `${prefix}/started`, beforeCommit: null, afterCommit: inputs.baseCommit, tree,
      packetDigest: workflowGitPacketDigest(started), packetJson: workflowGitPacketJson(started) }, journal, assertCurrent);
    for (const [index, result] of selected.entries()) {
      const effect = workflowGitPacketSnapshot<WorkflowIntegrationMergeIntent>({ roundId: context.roundId, generation: context.generation,
        inputsDigest: context.inputsDigest, writer: context.writer, commonDir: repository.commonDir, sequence: index + 1,
        workflowStepId: result.packet.context.scope.stepId, baseCommit: inputs.baseCommit, oursCommit: ours,
        theirsCommit: result.commit, branchResultDigest: result.packetDigest, resultRef: `${prefix}/merge-${String(index + 1).padStart(4, "0")}` });
      const evidence = await mergeBranch(context, effect, allowedPaths, journal, assertCurrent);
      merges.push(evidence); ours = evidence.commit; tree = evidence.tree;
      if (evidence.exitCode === 1) break;
    }
    const status = merges.at(-1)!.exitCode === 1 ? "conflicted" : "pending_verification";
    const patch = await readPatch(root, inputs.baseCommit, tree);
    const resultRef = `${prefix}/${status === "conflicted" ? "conflict" : "candidate"}`;
    await assertCurrent();
    const commit = ours;
    const packet = workflowGitPacketSnapshot<WorkflowIntegrationCandidatePacketV1>({ schemaVersion: 1, kind: "workflow_integration_candidate",
      status, applied: false, context, policy: WORKFLOW_INTEGRATION_POLICY,
      includedStepIds: merges.map(merge => merge.workflowStepId), excludedResults, merges, commit, tree,
      resultRef, patch: decode(patch), patchDigest: digest(patch) });
    const packetDigest = workflowGitPacketDigest(packet);
    await sealWorkflowGitResultRef(repository, { kind: "integration_create", roundId: context.roundId, generation: context.generation,
      commonDir: repository.commonDir, ref: resultRef, beforeCommit: null, afterCommit: commit, tree,
      packetDigest, packetJson: workflowGitPacketJson(packet) }, journal, assertCurrent);
    return Object.freeze({ status, applied: false, packet, packetDigest, commit, tree, resultRef });
  });
}

function snapshotContext(input: WorkflowIntegrationCandidateContext): WorkflowIntegrationCandidateContext {
  const inputs = normalizeWorkflowIntegrationRoundInputs(input.inputs);
  requireCandidate(inputs && input.inputsDigest === workflowIntegrationRoundInputsDigest(inputs), "workflow_integration_inputs_invalid");
  requireCandidate(identifier.test(input.roundId) && Number.isSafeInteger(input.generation) && input.generation > 0
    && input.repository && input.integrationScope && input.integrationReceipt && input.writer
    && [input.writer.bindingId, input.writer.workUnitId, input.writer.attemptId, input.writer.runtimeInstanceId, input.writer.fencingToken].every(identity)
    && Array.isArray(input.branchResults) && input.branchResults.length === inputs.participants.length,
  "workflow_integration_context_invalid");
  const context = workflowGitPacketSnapshot({ roundId: input.roundId, generation: input.generation, inputs, inputsDigest: input.inputsDigest,
    writer: input.writer, repository: input.repository, integrationScope: input.integrationScope,
    integrationReceipt: input.integrationReceipt, branchResults: input.branchResults });
  const { repository, integrationScope: scope, integrationReceipt: receipt } = context;
  requireCandidate(repository.root === inputs.canonicalWorkspaceRoot && repository.root === inputs.target.executionRoot
    && repository.commonDir === inputs.repositoryIdentity.commonDir && repository.head === inputs.baseCommit
    && repository.branchRef === inputs.target.branchRef && inputs.target.expectedHead === inputs.baseCommit
    && (inputs.repositoryIdentity.objectFormat === "sha1" ? inputs.baseCommit.length === 40 : inputs.baseCommit.length === 64)
    && [scope.worktreeId, scope.stepId].every(value => identifier.test(value))
    && scope.roundId === context.roundId && scope.generation === context.generation && scope.baseCommit === inputs.baseCommit
    && scope.executionRoot === join(scope.worktreeRoot, scope.worktreeId)
    && scope.branchRef === `refs/heads/ling/workflow/${scope.roundId}/${scope.stepId}/${scope.generation}-${scope.worktreeId}`
    && workflowGitRepositoryBasisDigest(scope.repository) === workflowGitRepositoryBasisDigest(repository)
    && scope.executionRoot === inputs.integration.executionRoot && scope.branchRef === inputs.integration.branchRef
    && scope.worktreeId === inputs.integration.worktreeId && receipt.worktreeId === scope.worktreeId
    && receipt.executionRoot === scope.executionRoot && receipt.branchRef === scope.branchRef
    && receipt.commonDir === repository.commonDir && receipt.baseCommit === inputs.baseCommit,
  "workflow_integration_scope_mismatch");
  const ids = new Set<string>(), roots = new Set([scope.executionRoot]), bindings = new Set<string>();
  for (const result of context.branchResults) {
    const branch = result.packet?.context, lineage = branch?.lineage, source = branch?.scope;
    requireCandidate(branch && lineage && source && !ids.has(source.stepId) && !roots.has(source.executionRoot)
      && !bindings.has(lineage.bindingId) && inputs.mergeOrder.includes(source.stepId) && source.roundId === context.roundId
      && source.generation === context.generation && source.baseCommit === inputs.baseCommit
      && workflowGitRepositoryBasisDigest(source.repository) === workflowGitRepositoryBasisDigest(repository)
      && lineage.workflowId === inputs.workflowId && lineage.canonicalWorkspaceId === inputs.canonicalWorkspaceId
      && lineage.canonicalWorkspaceRoot === inputs.canonicalWorkspaceRoot, "workflow_integration_branch_basis_mismatch");
    ids.add(source.stepId); roots.add(source.executionRoot); bindings.add(lineage.bindingId);
  }
  return Object.freeze({ ...context, branchResults: Object.freeze(inputs.mergeOrder.map(stepId =>
    context.branchResults.find(result => result.packet.context.scope.stepId === stepId)!)) });
}

async function inspectCurrentContext(context: WorkflowIntegrationCandidateContext): Promise<void> {
  const { inputs, repository } = context;
  const current = await inspectWorkflowGitRepository(repository.root, { allowDirtyCandidate: inputs.target.inputMode === "committed_head_only",
    hostStateRoot: repository.hostState?.root });
  requireCandidate(workflowGitRepositoryBasisDigest(current) === workflowGitRepositoryBasisDigest(repository),
    "workflow_integration_target_basis_changed");
  const receipt = await reconcileWorkflowGitWorktree(context.integrationScope);
  requireCandidate(workflowGitPacketJson(receipt) === workflowGitPacketJson(context.integrationReceipt), "workflow_integration_worktree_changed");
  requireCandidate((await workflowGit(context.integrationScope.executionRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"])).stdout.length === 0,
  "workflow_integration_worktree_not_clean");
}

async function mergeBranch(context: WorkflowIntegrationCandidateContext, effect: WorkflowIntegrationMergeIntent,
  allowedPaths: ReadonlySet<string>, journal: WorkflowIntegrationGitJournal, assertCurrent: () => Promise<void>): Promise<WorkflowIntegrationMergeEvidence> {
  await assertCurrent();
  const intentId = await journal.recordMergeIntent(effect);
  requireCandidate(identity(intentId), "workflow_integration_merge_intent_invalid");
  const root = context.repository.root;
  let attempted = false, rawOutput: string | undefined, evidence: WorkflowIntegrationMergeEvidence | undefined;
  try {
    await assertCurrent(); attempted = true;
    const merged = await mergeTree(root, effect);
    rawOutput = decode(merged.output);
    const parsed = parseMergeTree(merged.output, merged.exitCode);
    await inspectWorkflowGitTree(root, parsed.tree);
    await inspectChangedText(root, context.inputs.baseCommit, parsed.tree, merged.exitCode === 0 ? allowedPaths : undefined);
    const patch = await readPatch(root, effect.oursCommit, parsed.tree);
    await assertCurrent();
    const commit = await commitTree(root, parsed.tree, [effect.oursCommit, effect.theirsCommit],
      workflowGitPacketDigest({ effect, exitCode: merged.exitCode, tree: parsed.tree, rawOutputDigest: digest(merged.output) }));
    evidence = workflowGitPacketSnapshot({ ...effect, exitCode: merged.exitCode, ...parsed, commit,
      rawOutput, rawOutputDigest: digest(merged.output), patch: decode(patch), patchDigest: digest(patch) });
    await journal.recordMergeReceipt({ intentId, effect, outcome: "confirmed", evidence });
  } catch (cause) {
    const outcome = attempted ? "effect_unknown" : "blocked";
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "workflow_integration_merge_failed";
    try { await journal.recordMergeReceipt({ intentId, effect, outcome, evidence, rawOutput, code }); }
    catch (receiptCause) { throw new WorkflowIntegrationCandidateError("workflow_integration_merge_receipt_unconfirmed",
      { intentId, effect, evidence, rawOutput }, { cause: receiptCause }); }
    throw new WorkflowIntegrationCandidateError("workflow_integration_merge_unconfirmed", { intentId, effect, evidence, rawOutput }, { cause });
  }
  requireCandidate(evidence, "workflow_integration_merge_evidence_missing");
  // Close object creation before opening a separate ref effect; a round permits only one open intent.
  try {
    await sealWorkflowGitResultRef(context.repository, { kind: "integration_create", roundId: effect.roundId, generation: effect.generation,
      commonDir: effect.commonDir, ref: effect.resultRef, beforeCommit: null, afterCommit: evidence.commit, tree: evidence.tree,
      packetDigest: workflowGitPacketDigest(evidence), packetJson: workflowGitPacketJson(evidence) }, journal, assertCurrent);
  } catch (cause) {
    throw new WorkflowIntegrationCandidateError("workflow_integration_merge_unconfirmed", { intentId, effect, evidence, rawOutput }, { cause });
  }
  return evidence;
}

async function mergeTree(root: string, effect: WorkflowIntegrationMergeIntent): Promise<{ readonly exitCode: 0 | 1; readonly output: Buffer }> {
  try {
    const result = await workflowGit(root, ["-c", "merge.renames=false", "-c", "merge.directoryRenames=false", "-c", "merge.renormalize=false",
      "-c", "merge.conflictStyle=merge", "merge-tree", "--write-tree", "-z", "--messages", `--merge-base=${effect.baseCommit}`,
      effect.oursCommit, effect.theirsCommit]);
    return { exitCode: 0, output: result.stdout };
  } catch (cause) {
    const error = cause as { readonly code?: unknown; readonly stdout?: unknown };
    if (error.code === 1 && Buffer.isBuffer(error.stdout)) return { exitCode: 1, output: error.stdout };
    throw cause;
  }
}

function parseMergeTree(bytes: Buffer, exitCode: 0 | 1): Pick<WorkflowIntegrationMergeEvidence, "tree" | "stages" | "messages"> {
  requireCandidate(bytes.length > 0 && bytes.length <= WORKFLOW_INTEGRATION_POLICY.maxMergeOutputBytes && bytes.at(-1) === 0,
    "workflow_integration_merge_output_invalid");
  const records = decode(bytes.subarray(0, -1)).split("\0"), tree = records.shift()!;
  requireCandidate(oid.test(tree), "workflow_integration_merge_output_invalid");
  const stages: WorkflowIntegrationMergeEvidence["stages"][number][] = [], messages: WorkflowIntegrationMergeEvidence["messages"][number][] = [];
  while (records.length && records[0] !== "") {
    const record = records.shift()!, tab = record.indexOf("\t"), [mode, blob, stage] = record.slice(0, tab).split(" "), path = record.slice(tab + 1);
    requireCandidate(tab > 0 && ["100644", "100755"].includes(mode) && oid.test(blob) && ["1", "2", "3"].includes(stage)
      && safeWorkflowGitPath(path) && stages.length < WORKFLOW_INTEGRATION_POLICY.maxEntries, "workflow_integration_merge_output_invalid");
    stages.push({ path, mode, blob, stage: Number(stage) as 1 | 2 | 3 });
  }
  if (records.length) records.shift();
  while (records.length) {
    const count = records.shift()!;
    requireCandidate(/^[1-9]\d{0,4}$/u.test(count) && Number(count) <= WORKFLOW_INTEGRATION_POLICY.maxEntries
      && records.length >= Number(count) + 2, "workflow_integration_merge_output_invalid");
    const paths = records.splice(0, Number(count)), type = records.shift()!, message = records.shift()!;
    requireCandidate(paths.every(safeWorkflowGitPath) && type.length > 0 && messages.length < WORKFLOW_INTEGRATION_POLICY.maxEntries,
      "workflow_integration_merge_output_invalid");
    messages.push({ paths, type, message });
  }
  requireCandidate(exitCode === 1 || stages.length === 0, "workflow_integration_merge_output_invalid");
  return { tree, stages, messages };
}

async function inspectChangedText(root: string, base: string, tree: string, allowedPaths?: ReadonlySet<string>): Promise<void> {
  const changed = nulRecords((await workflowGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, tree, "--"])).stdout);
  requireCandidate(changed.length <= WORKFLOW_INTEGRATION_POLICY.maxEntries && changed.every(safeWorkflowGitPath), "workflow_integration_changed_paths_invalid");
  requireCandidate(!allowedPaths || changed.every(path => allowedPaths.has(path)), "workflow_integration_unauthorized_merge_path");
  let total = 0;
  for (const commit of [base, tree]) {
    const entries = nulRecords((await workflowGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout);
    for (const record of entries) {
      const tab = record.indexOf("\t"), path = record.slice(tab + 1);
      if (!changed.includes(path)) continue;
      const blob = record.slice(0, tab).split(" ")[2];
      const size = Number(await gitText(root, ["cat-file", "-s", blob]));
      requireCandidate(Number.isSafeInteger(size) && size >= 0 && size <= WORKFLOW_INTEGRATION_POLICY.maxFileBytes
        && (total += size) <= WORKFLOW_INTEGRATION_POLICY.maxChangedBytes, "workflow_integration_text_budget_exceeded");
      const bytes = (await workflowGit(root, ["cat-file", "blob", blob])).stdout;
      requireCandidate(bytes.length === size && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(decode(bytes)), "workflow_integration_binary_unsupported");
    }
  }
}

async function rejectCrossTreeAliases(root: string, trees: readonly string[]): Promise<void> {
  const prefixes = new Map<string, string>();
  for (const tree of trees) {
    await inspectWorkflowGitTree(root, tree);
    for (const record of nulRecords((await workflowGit(root, ["ls-tree", "-r", "-z", "--full-tree", tree])).stdout)) {
      const parts = record.slice(record.indexOf("\t") + 1).split("/");
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join("/"), folded = prefix.normalize("NFC").toLowerCase();
        requireCandidate(!prefixes.has(folded) || prefixes.get(folded) === prefix, "workflow_integration_ambiguous_case_path");
        prefixes.set(folded, prefix);
      }
    }
  }
}

async function readPatch(root: string, base: string, tree: string): Promise<Buffer> {
  const bytes = (await workflowGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--full-index", "--text", base, tree, "--"])).stdout;
  requireCandidate(bytes.length <= WORKFLOW_INTEGRATION_POLICY.maxPatchBytes, "workflow_integration_patch_budget_exceeded"); return bytes;
}
async function commitTree(root: string, tree: string, parents: readonly string[], packetDigest: string): Promise<string> {
  const commit = await gitText(root, ["commit-tree", tree, ...[...new Set(parents)].flatMap(parent => ["-p", parent])],
    Buffer.from(`Ling workflow integration candidate\n\n${packetDigest}\n`));
  requireCandidate(oid.test(commit), "workflow_integration_commit_invalid"); return commit;
}
async function gitText(root: string, args: readonly string[], input?: Buffer): Promise<string> {
  return decode((await workflowGit(root, args, input ? { input } : undefined)).stdout).trim();
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new WorkflowIntegrationCandidateError("workflow_integration_non_utf8_unsupported", {}, { cause }); }
}
function nulRecords(bytes: Buffer): string[] {
  requireCandidate(!bytes.length || bytes.at(-1) === 0, "workflow_integration_records_invalid");
  return bytes.length ? decode(bytes.subarray(0, -1)).split("\0") : [];
}
