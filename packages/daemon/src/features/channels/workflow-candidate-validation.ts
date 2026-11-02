import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest } from "@ling-stack/core";
import { workflowGit } from "../workspaces/managed-worktrees.js";
import { inspectWorkflowGitRepository, inspectWorkflowGitTree, reconcileWorkflowGitWorktree, safeWorkflowGitPath,
  withWorkflowGitRepositoryLock, workflowGitRepositoryBasisDigest } from "../workspaces/workflow-git-repository.js";
import { inspectSealedWorkflowBranchResult, workflowGitPacketDigest, workflowGitPacketJson, workflowGitPacketSnapshot,
  workflowGitResultRef, type WorkflowBranchResult } from "./workflow-branch-result.js";
import { WORKFLOW_INTEGRATION_POLICY, type WorkflowIntegrationCandidateContext, type WorkflowIntegrationCandidateResult,
  type WorkflowIntegrationMergeIntent } from "./workflow-integration-candidate.js";

export const WORKFLOW_CANDIDATE_VALIDATION_POLICY = Object.freeze({ schemaVersion: 1, maxBranches: 64, maxTreeEntries: 10000,
  maxChangedFiles: 1024, maxJsonFiles: 128, maxFileBytes: 1024 * 1024, maxChangedBytes: 6 * 1024 * 1024,
  maxPatchBytes: 4 * 1024 * 1024, maxCandidatePacketBytes: 32 * 1024 * 1024, maxOutputBytes: 256 * 1024, maxDiagnosticBytes: 4096 });

export type WorkflowCandidateValidatorId = "git-diff-check" | "json-syntax";
export interface WorkflowCandidateValidationRequirement { readonly id: string; readonly fingerprint: string }
export interface WorkflowCandidateValidatorDefinition {
  readonly id: WorkflowCandidateValidatorId;
  readonly version: 1;
  readonly fingerprint: string;
  readonly scope: "candidate_tree_static_checks";
}

const whitespace = "blank-at-eol,blank-at-eof,space-before-tab";
const diffCheckArgs = ["-c", `core.whitespace=${whitespace}`, "diff", "--check", "--no-ext-diff", "--no-textconv",
  "--no-renames", "--no-color", "--text"] as const;
const patchArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--full-index", "--text"] as const;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** Fixed Host implementations, not a registry of repository commands or an execution grant. */
export const WORKFLOW_CANDIDATE_VALIDATORS: readonly WorkflowCandidateValidatorDefinition[] = workflowGitPacketSnapshot([
  { id: "git-diff-check", version: 1, scope: "candidate_tree_static_checks", fingerprint: `wcv1_${sha256(workflowGitPacketJson({
    id: "git-diff-check", version: 1, command: diffCheckArgs, input: "base_commit_to_candidate_tree",
    attributes: "whitespace_unspecified", policy: WORKFLOW_CANDIDATE_VALIDATION_POLICY }))}` },
  { id: "json-syntax", version: 1, scope: "candidate_tree_static_checks", fingerprint: `wcv1_${sha256(workflowGitPacketJson({
    id: "json-syntax", version: 1, engine: "JSON.parse", encoding: "fatal_utf8_preserve_bom",
    input: "changed_candidate_blobs_case_insensitive_dot_json_no_deleted_files", policy: WORKFLOW_CANDIDATE_VALIDATION_POLICY }))}` },
]);

export class WorkflowCandidateValidationError extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(code, options);
  }
}
const requireValidation: (condition: unknown, code: string, details?: Readonly<Record<string, unknown>>) => asserts condition =
  (condition, code, details) => { if (!condition) throw new WorkflowCandidateValidationError(code, details); };

export interface WorkflowCandidateValidationContext extends WorkflowIntegrationCandidateContext {
  readonly candidatePacketDigest: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly candidateResultRef: string;
  readonly validationRequirements: readonly WorkflowCandidateValidationRequirement[];
  readonly requirementsDigest: string;
}

/** Host-only: compare the persisted round, candidate artifact, requirements, owner/fence and cancellation intent.
 * This callback must throw on drift. A supplied packet/digest is not authority, approval or a project-test result. */
export type AssertWorkflowCandidateValidationAuthority = (context: WorkflowCandidateValidationContext) => void | Promise<void>;

export interface WorkflowCandidateValidationScope {
  readonly kind: "candidate_tree_static_checks";
  readonly readOnly: true;
  readonly executionRoot: string;
  readonly commonDir: string;
  readonly repositoryBasisDigest: string;
  readonly roundId: string;
  readonly generation: number;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
}
export interface WorkflowCandidateValidationArtifact {
  readonly contentType: "application/json";
  readonly payload: string;
  readonly digest: string;
}
export interface WorkflowCandidateValidationItem extends WorkflowCandidateValidatorDefinition {
  readonly status: "passed" | "failed";
  readonly exitCode: number;
  readonly executionScope: WorkflowCandidateValidationScope;
  readonly artifact: WorkflowCandidateValidationArtifact;
}
export interface WorkflowCandidateVerificationPacketV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_candidate_verification";
  readonly status: "passed" | "failed";
  readonly applied: false;
  readonly projectTestsRun: false;
  readonly candidate: { readonly packetDigest: string; readonly commit: string; readonly tree: string;
    readonly resultRef: string; readonly patchDigest: string };
  readonly inputsDigest: string;
  readonly requirementsDigest: string;
  readonly validationRequirements: readonly WorkflowCandidateValidationRequirement[];
  readonly writer: WorkflowIntegrationCandidateContext["writer"];
  readonly policy: typeof WORKFLOW_CANDIDATE_VALIDATION_POLICY;
  readonly executionScope: WorkflowCandidateValidationScope;
  readonly changedPaths: readonly string[];
  readonly results: readonly WorkflowCandidateValidationItem[];
}
export interface WorkflowCandidateValidationResult {
  readonly status: "passed" | "failed";
  readonly applied: false;
  readonly packet: WorkflowCandidateVerificationPacketV1;
  readonly packetDigest: string;
  /** Canonical evidence ready for the coordinator's durable artifact store; this helper writes no artifact/ref. */
  readonly artifact: WorkflowCandidateValidationArtifact;
}

export function workflowCandidateValidationRequirementsDigest(requirements: readonly WorkflowCandidateValidationRequirement[]): string {
  return `wvr1_${sha256(workflowGitPacketJson(snapshotRequirements(requirements)))}`;
}

/** No repository scripts, checkout, alternate index, ref updates or apply authorization. */
export async function validateWorkflowIntegrationCandidate(input: {
  readonly candidate: WorkflowIntegrationCandidateResult;
  readonly validationRequirements: readonly WorkflowCandidateValidationRequirement[];
  readonly assertCurrentAuthority: AssertWorkflowCandidateValidationAuthority;
  readonly signal?: AbortSignal;
}): Promise<WorkflowCandidateValidationResult> {
  const { assertCurrentAuthority, signal } = input;
  requireValidation(typeof assertCurrentAuthority === "function", "workflow_candidate_validation_authority_required");
  const requirements = snapshotRequirements(input.validationRequirements);
  const candidateJson = workflowGitPacketJson(input.candidate);
  requireValidation(Buffer.byteLength(candidateJson) <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxCandidatePacketBytes,
    "workflow_candidate_validation_packet_budget_exceeded");
  const candidate = workflowGitPacketSnapshot(input.candidate);
  validateCandidatePacket(candidate, requirements);
  const context = workflowGitPacketSnapshot<WorkflowCandidateValidationContext>({ ...candidate.packet.context,
    candidatePacketDigest: candidate.packetDigest, candidateCommit: candidate.commit, candidateTree: candidate.tree,
    candidateResultRef: candidate.resultRef, validationRequirements: requirements,
    requirementsDigest: workflowCandidateValidationRequirementsDigest(requirements) });
  const { repository, inputs } = context, root = repository.root;
  const assertAuthority = async () => {
    requireValidation(!signal?.aborted, "workflow_candidate_validation_cancelled");
    const result = await assertCurrentAuthority(context);
    requireValidation(!signal?.aborted, "workflow_candidate_validation_cancelled");
    requireValidation(result === undefined, "workflow_candidate_validation_authority_return_invalid");
  };
  // Check both fulfilled and rejected reads. Revocation cannot be recorded as an ordinary failing validator.
  const checked: Checked = async action => {
    await assertAuthority();
    let result;
    try { result = await action(); }
    catch (cause) { await assertAuthority(); throw cause; }
    await assertAuthority();
    return result;
  };
  const git = (args: readonly string[], bytes?: Buffer) => checked(() => workflowGit(root, args, bytes ? { input: bytes } : undefined));
  const scope = workflowGitPacketSnapshot<WorkflowCandidateValidationScope>({ kind: "candidate_tree_static_checks", readOnly: true,
    executionRoot: root, commonDir: repository.commonDir, repositoryBasisDigest: workflowGitRepositoryBasisDigest(repository),
    roundId: context.roundId, generation: context.generation, baseCommit: inputs.baseCommit,
    candidateCommit: candidate.commit, candidateTree: candidate.tree });
  return checked(() => withWorkflowGitRepositoryLock(repository, async () => {
    const inspectCurrent = async () => {
      const current = await checked(() => inspectWorkflowGitRepository(root,
        { allowDirtyCandidate: inputs.target.inputMode === "committed_head_only" }));
      requireValidation(workflowGitRepositoryBasisDigest(current) === scope.repositoryBasisDigest,
        "workflow_candidate_validation_repository_changed");
      const receipt = await checked(() => reconcileWorkflowGitWorktree(context.integrationScope));
      requireValidation(workflowGitPacketJson(receipt) === workflowGitPacketJson(context.integrationReceipt),
        "workflow_candidate_validation_integration_changed");
      requireValidation((await checked(() => workflowGit(context.integrationScope.executionRoot,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]))).stdout.length === 0,
      "workflow_candidate_validation_integration_dirty");
      for (const [ref, commit] of [[candidate.resultRef, candidate.commit], ...candidate.packet.merges.map(merge => [merge.resultRef, merge.commit]),
        ...context.branchResults.map(branch => [branch.resultRef, branch.commit])]) {
        requireValidation(await checked(() => workflowGitResultRef(root, ref)) === commit, "workflow_candidate_validation_ref_changed", { ref });
      }
    };
    await checked(inspectCurrent);
    for (const branch of context.branchResults) await checked(() => inspectSealedWorkflowBranchResult(root, branch));
    await checked(() => inspectCandidateObjects(candidate, git, checked));
    const base = await checked(() => readTree(root, inputs.baseCommit, git, checked));
    const next = await checked(() => readTree(root, candidate.tree, git, checked));
    const changes = changedEntries(base, next);
    const jsonChanges = changes.filter(change => change.path.toLowerCase().endsWith(".json"));
    requireValidation(jsonChanges.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxJsonFiles,
      "workflow_candidate_validation_json_budget_exceeded");
    const results: WorkflowCandidateValidationItem[] = [];
    for (const requirement of requirements) {
      await checked(inspectCurrent);
      const definition = WORKFLOW_CANDIDATE_VALIDATORS.find(validator => validator.id === requirement.id)!;
      const result = await checked(() => definition.id === "git-diff-check"
        ? runDiffCheck(context, changes, scope, git, checked)
        : runJsonSyntax(jsonChanges, scope, git));
      results.push({ ...definition, ...result });
      await checked(inspectCurrent);
    }
    await checked(inspectCurrent);
    const packet = workflowGitPacketSnapshot<WorkflowCandidateVerificationPacketV1>({ schemaVersion: 1,
      kind: "workflow_candidate_verification", status: results.every(result => result.status === "passed") ? "passed" : "failed",
      applied: false, projectTestsRun: false, candidate: { packetDigest: candidate.packetDigest, commit: candidate.commit,
        tree: candidate.tree, resultRef: candidate.resultRef, patchDigest: candidate.packet.patchDigest }, inputsDigest: context.inputsDigest,
      requirementsDigest: context.requirementsDigest, validationRequirements: requirements, writer: context.writer,
      policy: WORKFLOW_CANDIDATE_VALIDATION_POLICY, executionScope: scope, changedPaths: changes.map(change => change.path), results });
    return workflowGitPacketSnapshot({ status: packet.status, applied: false, packet,
      packetDigest: workflowGitPacketDigest(packet), artifact: artifact(packet) });
  }));
}

type Checked = <T>(action: () => Promise<T>) => Promise<T>;
type GitRead = (args: readonly string[], input?: Buffer) => ReturnType<typeof workflowGit>;
interface TreeEntry { readonly mode: string; readonly blob: string; readonly sizeBytes: number }
interface Change { readonly path: string; readonly before?: TreeEntry; readonly after?: TreeEntry }
type ItemResult = Pick<WorkflowCandidateValidationItem, "status" | "exitCode" | "executionScope" | "artifact">;

function snapshotRequirements(value: readonly WorkflowCandidateValidationRequirement[]): readonly WorkflowCandidateValidationRequirement[] {
  requireValidation(Array.isArray(value) && value.length > 0, "workflow_candidate_validation_requirements_empty");
  const ids = new Set<string>();
  for (const requirement of value) {
    requireValidation(requirement && typeof requirement === "object" && !Array.isArray(requirement)
      && Object.keys(requirement).sort().join(",") === "fingerprint,id" && typeof requirement.id === "string"
      && typeof requirement.fingerprint === "string", "workflow_candidate_validation_requirement_invalid");
    requireValidation(!ids.has(requirement.id), "workflow_candidate_validation_requirement_duplicate"); ids.add(requirement.id);
    const definition = WORKFLOW_CANDIDATE_VALIDATORS.find(validator => validator.id === requirement.id);
    requireValidation(definition, "workflow_candidate_validation_validator_unknown", { id: requirement.id });
    requireValidation(definition.fingerprint === requirement.fingerprint, "workflow_candidate_validation_fingerprint_mismatch", { id: requirement.id });
  }
  return workflowGitPacketSnapshot([...value].sort((a, b) => compare(a.id, b.id)));
}

function validateCandidatePacket(candidate: WorkflowIntegrationCandidateResult, requirements: readonly WorkflowCandidateValidationRequirement[]): void {
  const packet = candidate?.packet, context = packet?.context, inputs = normalizeWorkflowIntegrationRoundInputs(context?.inputs);
  requireValidation(candidate.status === "pending_verification" && packet?.status === "pending_verification",
    "workflow_candidate_validation_candidate_conflicted");
  requireValidation(packet.schemaVersion === 1 && packet.kind === "workflow_integration_candidate" && candidate.applied === false
    && packet.applied === false && candidate.packetDigest === workflowGitPacketDigest(packet)
    && candidate.commit === packet.commit && candidate.tree === packet.tree && candidate.resultRef === packet.resultRef
    && oid.test(candidate.commit) && oid.test(candidate.tree) && inputs && candidate.commit.length === inputs.baseCommit.length
    && candidate.tree.length === inputs.baseCommit.length && context.inputsDigest === workflowIntegrationRoundInputsDigest(inputs)
    && workflowGitPacketJson(context.inputs) === workflowGitPacketJson(inputs)
    && workflowGitPacketJson(packet.policy) === workflowGitPacketJson(WORKFLOW_INTEGRATION_POLICY)
    && typeof packet.patch === "string" && Buffer.byteLength(packet.patch) <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxPatchBytes
    && sha256(packet.patch) === packet.patchDigest, "workflow_candidate_validation_packet_mismatch");
  requireValidation(workflowGitPacketJson(snapshotRequirements(inputs.validationRequirements)) === workflowGitPacketJson(requirements),
    "workflow_candidate_validation_requirements_changed");
  const { repository, integrationScope: scope, integrationReceipt: receipt } = context;
  requireValidation(identifier.test(context.roundId) && Number.isSafeInteger(context.generation) && context.generation > 0
    && repository && scope && receipt && context.writer && [scope.worktreeId, scope.stepId].every(value => identifier.test(value))
    && repository.root === inputs.canonicalWorkspaceRoot && repository.root === inputs.target.executionRoot
    && repository.commonDir === inputs.repositoryIdentity.commonDir && repository.head === inputs.baseCommit
    && repository.branchRef === inputs.target.branchRef && inputs.target.cleanStateDigest === workflowGitRepositoryBasisDigest(repository)
    && scope.roundId === context.roundId && scope.generation === context.generation && scope.baseCommit === inputs.baseCommit
    && scope.executionRoot === join(scope.worktreeRoot, scope.worktreeId) && scope.executionRoot === inputs.integration.executionRoot
    && scope.branchRef === inputs.integration.branchRef && scope.worktreeId === inputs.integration.worktreeId
    && scope.branchRef === `refs/heads/ling/workflow/${context.roundId}/${scope.stepId}/${context.generation}-${scope.worktreeId}`
    && workflowGitRepositoryBasisDigest(scope.repository) === workflowGitRepositoryBasisDigest(repository)
    && receipt.worktreeId === scope.worktreeId && receipt.executionRoot === scope.executionRoot && receipt.branchRef === scope.branchRef
    && receipt.baseCommit === inputs.baseCommit && receipt.commonDir === repository.commonDir
    && Array.isArray(context.branchResults) && context.branchResults.length === inputs.participants.length
    && context.branchResults.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxBranches, "workflow_candidate_validation_scope_mismatch");
  const selected: WorkflowBranchResult[] = [], excluded = [], roots = new Set([scope.executionRoot]), bindings = new Set<string>();
  for (const [index, participant] of inputs.participants.entries()) {
    const branch: WorkflowBranchResult = context.branchResults[index], branchContext = branch?.packet?.context, source = branchContext?.scope, lineage = branchContext?.lineage;
    requireValidation(branch && source && lineage && source.stepId === inputs.mergeOrder[index]
      && source.stepId === participant.workflowStepId && !roots.has(source.executionRoot) && !bindings.has(lineage.bindingId)
      && source.roundId === context.roundId && source.generation === context.generation && source.baseCommit === inputs.baseCommit
      && workflowGitRepositoryBasisDigest(source.repository) === workflowGitRepositoryBasisDigest(repository)
      && lineage.workflowId === inputs.workflowId && lineage.canonicalWorkspaceId === inputs.canonicalWorkspaceId
      && lineage.canonicalWorkspaceRoot === repository.root, "workflow_candidate_validation_branch_mismatch");
    roots.add(source.executionRoot); bindings.add(lineage.bindingId);
    const terminal = branch.packet.terminal;
    requireValidation(terminal && Array.isArray(terminal.validations), "workflow_candidate_validation_branch_mismatch");
    if (terminal.outcome === "succeeded" && terminal.validations.every((validation: { readonly exitCode: number }) => validation.exitCode === 0)) selected.push(branch);
    else {
      requireValidation(!participant.required && inputs.optionalFailurePolicy === "exclude_failed_with_evidence",
        "workflow_candidate_validation_branch_unsuccessful");
      excluded.push({ workflowStepId: source.stepId, packetDigest: branch.packetDigest,
        reason: terminal.outcome === "succeeded" ? "validation_failed" : terminal.outcome });
    }
  }
  const prefix = `refs/ling/workflow/candidates/${context.roundId}/${context.generation}-${scope.worktreeId}`;
  requireValidation(candidate.resultRef === `${prefix}/candidate` && Array.isArray(packet.merges) && packet.merges.length > 0
    && packet.merges.length === selected.length && workflowGitPacketJson(packet.includedStepIds) === workflowGitPacketJson(selected.map(branch => branch.packet.context.scope.stepId))
    && workflowGitPacketJson(packet.excludedResults) === workflowGitPacketJson(excluded), "workflow_candidate_validation_merge_mismatch");
  let previous = inputs.baseCommit;
  for (const [index, merge] of packet.merges.entries()) {
    requireValidation(merge.sequence === index + 1 && merge.roundId === context.roundId && merge.generation === context.generation
      && merge.inputsDigest === context.inputsDigest && workflowGitPacketJson(merge.writer) === workflowGitPacketJson(context.writer)
      && merge.commonDir === repository.commonDir && merge.workflowStepId === selected[index].packet.context.scope.stepId
      && merge.baseCommit === inputs.baseCommit && merge.oursCommit === previous && merge.theirsCommit === selected[index].commit
      && merge.branchResultDigest === selected[index].packetDigest && merge.resultRef === `${prefix}/merge-${String(index + 1).padStart(4, "0")}`
      && merge.exitCode === 0 && Array.isArray(merge.stages) && merge.stages.length === 0 && Array.isArray(merge.messages)
      && oid.test(merge.tree) && oid.test(merge.commit) && merge.tree.length === candidate.tree.length && merge.commit.length === candidate.commit.length
      && typeof merge.rawOutput === "string" && Buffer.byteLength(merge.rawOutput) <= WORKFLOW_INTEGRATION_POLICY.maxMergeOutputBytes
      && sha256(merge.rawOutput) === merge.rawOutputDigest && typeof merge.patch === "string"
      && Buffer.byteLength(merge.patch) <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxPatchBytes && sha256(merge.patch) === merge.patchDigest,
    "workflow_candidate_validation_merge_mismatch");
    previous = merge.commit;
  }
  requireValidation(packet.merges.at(-1)!.tree === candidate.tree, "workflow_candidate_validation_merge_mismatch");
}

async function inspectCandidateObjects(candidate: WorkflowIntegrationCandidateResult, git: GitRead, checked: Checked): Promise<void> {
  const packet = candidate.packet, context = packet.context, base = context.inputs.baseCommit;
  const prefix = candidate.resultRef.slice(0, -"candidate".length);
  requireValidation(await checked(() => workflowGitResultRef(context.repository.root, `${prefix}started`)) === base,
    "workflow_candidate_validation_ref_changed");
  const inspectCommit = async (commit: string, tree: string, parents: readonly string[], messageDigest: string) => {
    const raw = decode((await git(["cat-file", "commit", commit])).stdout), boundary = raw.indexOf("\n\n");
    const headers = raw.slice(0, boundary).split("\n");
    requireValidation(boundary > 0 && headers[0] === `tree ${tree}`
      && workflowGitPacketJson(headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7))) === workflowGitPacketJson([...new Set(parents)])
      && raw.slice(boundary + 2) === `Ling workflow integration candidate\n\n${messageDigest}\n`, "workflow_candidate_validation_commit_mismatch");
  };
  for (const merge of packet.merges) {
    const effect: WorkflowIntegrationMergeIntent = { roundId: merge.roundId, generation: merge.generation, inputsDigest: merge.inputsDigest,
      writer: merge.writer, commonDir: merge.commonDir, sequence: merge.sequence, workflowStepId: merge.workflowStepId,
      baseCommit: merge.baseCommit, oursCommit: merge.oursCommit, theirsCommit: merge.theirsCommit,
      branchResultDigest: merge.branchResultDigest, resultRef: merge.resultRef };
    await checked(() => inspectCommit(merge.commit, merge.tree, [merge.oursCommit, merge.theirsCommit],
      workflowGitPacketDigest({ effect, exitCode: merge.exitCode, tree: merge.tree, rawOutputDigest: merge.rawOutputDigest })));
    const patch = (await git([...patchArgs, merge.oursCommit, merge.tree, "--"])).stdout;
    requireValidation(patch.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxPatchBytes && sha256(patch) === merge.patchDigest
      && decode(patch) === merge.patch, "workflow_candidate_validation_patch_mismatch");
  }
  requireValidation(candidate.commit === packet.merges.at(-1)!.commit, "workflow_candidate_validation_commit_mismatch");
  const patch = (await git([...patchArgs, base, candidate.tree, "--"])).stdout;
  requireValidation(patch.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxPatchBytes && sha256(patch) === packet.patchDigest
    && decode(patch) === packet.patch, "workflow_candidate_validation_patch_mismatch");
}

async function readTree(root: string, tree: string, git: GitRead, checked: Checked): Promise<ReadonlyMap<string, TreeEntry>> {
  // Reuse the Host tree checks for path aliases, special entries and unsafe attributes.
  // The caller also checks authority around the inspector's complete read-only observation.
  await checked(() => inspectWorkflowGitTree(root, tree));
  const entries = new Map<string, TreeEntry>();
  const bytes = (await git(["ls-tree", "-r", "-z", "--long", "--full-tree", tree])).stdout;
  for (const record of nulRecords(bytes)) {
    const tab = record.indexOf("\t"), [mode, type, blob, size] = record.slice(0, tab).trim().split(/\s+/u), path = record.slice(tab + 1);
    requireValidation(tab > 0 && ["100644", "100755"].includes(mode) && type === "blob" && oid.test(blob) && blob.length === tree.length
      && safeWorkflowGitPath(path) && /^\d+$/u.test(size) && Number.isSafeInteger(Number(size)) && !entries.has(path),
    "workflow_candidate_validation_tree_invalid");
    entries.set(path, { mode, blob, sizeBytes: Number(size) });
    requireValidation(entries.size <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxTreeEntries, "workflow_candidate_validation_tree_budget_exceeded");
  }
  return entries;
}

function changedEntries(base: ReadonlyMap<string, TreeEntry>, next: ReadonlyMap<string, TreeEntry>): readonly Change[] {
  const names = new Map<string, string>(), changes: Change[] = [];
  let bytes = 0;
  for (const path of [...new Set([...base.keys(), ...next.keys()])].sort(compare)) {
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      requireValidation(!names.has(folded) || names.get(folded) === prefix, "workflow_candidate_validation_path_alias"); names.set(folded, prefix);
    }
    const before = base.get(path), after = next.get(path);
    if (before?.blob === after?.blob && before?.mode === after?.mode) continue;
    for (const entry of [before, after]) if (entry) {
      bytes += entry.sizeBytes;
      requireValidation(entry.sizeBytes <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxFileBytes
        && bytes <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxChangedBytes, "workflow_candidate_validation_content_budget_exceeded");
    }
    changes.push({ path, ...(before ? { before } : {}), ...(after ? { after } : {}) });
    requireValidation(changes.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxChangedFiles, "workflow_candidate_validation_changed_files_budget_exceeded");
  }
  return changes;
}

async function runDiffCheck(context: WorkflowCandidateValidationContext, changes: readonly Change[], scope: WorkflowCandidateValidationScope,
  git: GitRead, checked: Checked): Promise<ItemResult> {
  const checkAttributes = async () => {
    if (!changes.length) return;
    const records = nulRecords((await git(["check-attr", "-z", "--stdin", "whitespace"], Buffer.from(changes.map(change => `${change.path}\0`).join("")))).stdout);
    requireValidation(records.length === changes.length * 3 && changes.every((change, index) => records[index * 3] === change.path
      && records[index * 3 + 1] === "whitespace" && records[index * 3 + 2] === "unspecified"), "workflow_candidate_validation_whitespace_attributes_unsupported");
  };
  await checked(checkAttributes);
  const args = [...diffCheckArgs, context.inputs.baseCommit, context.candidateTree, "--"];
  const result = await checked(async () => {
    try { return { ...await workflowGit(context.repository.root, args), exitCode: 0 }; }
    catch (cause) {
      const error = cause as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
      if (error.code === 2 && Buffer.isBuffer(error.stdout) && error.stdout.length > 0 && Buffer.isBuffer(error.stderr) && !error.stderr.length) {
        return { stdout: error.stdout, stderr: error.stderr, exitCode: 2 };
      }
      throw cause;
    }
  });
  await checked(checkAttributes);
  requireValidation(result.stdout.length + result.stderr.length <= WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxOutputBytes,
    "workflow_candidate_validation_output_budget_exceeded");
  return { status: result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, executionScope: scope,
    artifact: artifact({ engine: "host_git", actorProfile: "workflow_isolation_v1", command: ["/usr/bin/git", ...args], exitCode: result.exitCode, filesExamined: changes.length,
      stdout: decode(result.stdout), stderr: decode(result.stderr), stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr) }) };
}

async function runJsonSyntax(changes: readonly Change[], scope: WorkflowCandidateValidationScope, git: GitRead): Promise<ItemResult> {
  const files = [], deletedPaths = [];
  for (const change of changes) {
    if (!change.after) { deletedPaths.push(change.path); continue; }
    const { blob, mode, sizeBytes } = change.after;
    const bytes = (await git(["cat-file", "blob", blob])).stdout;
    const actualBlob = createHash(blob.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    requireValidation(bytes.length === sizeBytes && actualBlob === blob, "workflow_candidate_validation_blob_changed", { path: change.path });
    let diagnostic: string | undefined;
    try { JSON.parse(decode(bytes)); }
    catch (cause) {
      // Syntax/encoding failures are evidence; Git, cancellation and authority errors never enter this catch.
      requireValidation(cause instanceof SyntaxError || cause instanceof WorkflowCandidateValidationError && cause.code === "workflow_candidate_validation_non_utf8",
        "workflow_candidate_validation_parser_failed");
      diagnostic = Buffer.from(cause.message).subarray(0, WORKFLOW_CANDIDATE_VALIDATION_POLICY.maxDiagnosticBytes).toString("utf8");
    }
    files.push({ path: change.path, change: change.before ? "modify" : "add", blob, mode, sizeBytes, sha256: sha256(bytes),
      status: diagnostic === undefined ? "passed" : "failed", ...(diagnostic === undefined ? {} : { diagnostic }) });
  }
  const exitCode = files.some(file => file.status === "failed") ? 1 : 0;
  return { status: exitCode === 0 ? "passed" : "failed", exitCode, executionScope: scope,
    artifact: artifact({ engine: "JSON.parse", encoding: "utf-8", source: "candidate_tree_blobs", exitCode,
      filesExamined: files.length, files, deletedPaths }) };
}

function artifact(value: unknown): WorkflowCandidateValidationArtifact {
  return { contentType: "application/json", payload: workflowGitPacketJson(value), digest: workflowGitPacketDigest(value) };
}
function decode(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (cause) { throw new WorkflowCandidateValidationError("workflow_candidate_validation_non_utf8", {}, { cause }); }
}
function nulRecords(bytes: Buffer): string[] {
  requireValidation(!bytes.length || bytes.at(-1) === 0, "workflow_candidate_validation_records_invalid");
  return bytes.length ? decode(bytes.subarray(0, -1)).split("\0") : [];
}
