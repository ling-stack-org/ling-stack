import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeAttemptFenceV1, WorkflowStepStartOwnerV1 } from "@ling-stack/core";
import { workflowGit } from "../workspaces/managed-worktrees.js";
import { inspectWorkflowGitRepository, inspectWorkflowGitTree, safeWorkflowGitPath, withWorkflowGitRepositoryLock,
  type WorkflowGitRepository, type WorkflowGitWorktreeReceipt, type WorkflowGitWorktreeScope } from "../workspaces/workflow-git-repository.js";

export const WORKFLOW_BRANCH_CAPTURE_POLICY = Object.freeze({ schemaVersion: 1, maxEntries: 10000, maxDepth: 32,
  maxFileBytes: 1024 * 1024, maxScannedBytes: 64 * 1024 * 1024, maxChangedBytes: 6 * 1024 * 1024,
  maxPatchBytes: 4 * 1024 * 1024 });

export class WorkflowBranchResultError extends Error {
  constructor(readonly code: string, readonly details: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface WorkflowBranchLineage extends RuntimeAttemptFenceV1 {
  readonly workflowId: string;
  readonly canonicalWorkspaceId: string;
  readonly canonicalWorkspaceRoot: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly runId: string;
  readonly startOwner: WorkflowStepStartOwnerV1;
}

export interface WorkflowBranchCaptureContext {
  readonly scope: WorkflowGitWorktreeScope;
  readonly receipt: WorkflowGitWorktreeReceipt;
  readonly lineage: WorkflowBranchLineage;
  /** Exact, repository-relative file paths. No directory grants or pathspecs. */
  readonly allowedPaths: readonly string[];
}

export interface WorkflowBranchValidationEvidence {
  readonly id: string;
  readonly command: readonly string[];
  readonly executionRoot: string;
  readonly inputScopeDigest: string;
  readonly exitCode: number;
  readonly artifactRef: string;
}

export interface WorkflowBranchTerminalEvidence {
  readonly lineage: WorkflowBranchLineage;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly terminalArtifactRef: string;
  readonly quiescenceArtifactRef: string;
  readonly toolCompletionArtifactRef: string;
  readonly outputPacketArtifactRef: string;
  readonly contextArtifactRefs: readonly string[];
  readonly validations: readonly WorkflowBranchValidationEvidence[];
  readonly unknownEffects: readonly string[];
}

/** Host-only: recheck the actual current fence, terminal, child drain and completed tool journals.
 * A Run/step status, a model claim or a timeout is not this authority; the Host terminal-capture adapter supplies it. */
export type AssertWorkflowBranchTerminalQuiescent =
  (context: WorkflowBranchCaptureContext) => WorkflowBranchTerminalEvidence | Promise<WorkflowBranchTerminalEvidence>;

export interface WorkflowGitRefEffect {
  readonly kind: "branch_capture" | "integration_create";
  readonly roundId: string;
  readonly generation: number;
  readonly commonDir: string;
  readonly ref: string;
  readonly beforeCommit: null;
  readonly afterCommit: string;
  readonly tree: string;
  readonly packetDigest: string;
  readonly packetJson: string;
}

export interface WorkflowGitRefJournal {
  /** Persist the intent and packet artifact, then close the SQLite transaction before returning. */
  readonly recordIntent: (effect: WorkflowGitRefEffect) => Promise<string>;
  readonly recordReceipt: (receipt: { readonly intentId: string; readonly effect: WorkflowGitRefEffect;
    readonly outcome: "confirmed" | "blocked" | "effect_unknown"; readonly observedCommit: string | null }) => Promise<void>;
}

export interface WorkflowBranchFileVersion {
  readonly mode: "100644" | "100755";
  readonly blob: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface WorkflowBranchChangedPath {
  readonly path: string;
  readonly change: "add" | "modify" | "delete";
  readonly before?: WorkflowBranchFileVersion;
  readonly after?: WorkflowBranchFileVersion;
}

export interface WorkflowBranchResultPacketV1 {
  readonly schemaVersion: 1;
  readonly kind: "workflow_branch_result";
  readonly context: WorkflowBranchCaptureContext;
  readonly terminal: WorkflowBranchTerminalEvidence;
  readonly policy: typeof WORKFLOW_BRANCH_CAPTURE_POLICY;
  readonly baseCommit: string;
  readonly commit: string;
  readonly tree: string;
  readonly resultRef: string;
  readonly changedPaths: readonly WorkflowBranchChangedPath[];
  readonly patch: string;
  readonly patchDigest: string;
  readonly discovery: { readonly trackedPaths: number; readonly files: number; readonly directories: number;
    readonly newPaths: readonly string[]; readonly ignoredResidue: readonly string[]; readonly excludedPaths: readonly string[] };
}

export interface WorkflowBranchResult {
  readonly status: "sealed";
  readonly packet: WorkflowBranchResultPacketV1;
  readonly packetDigest: string;
  readonly commit: string;
  readonly tree: string;
  readonly resultRef: string;
}

const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const requireCapture: (condition: unknown, code: string, details?: Readonly<Record<string, unknown>>) => asserts condition =
  (condition, code, details) => { if (!condition) throw new WorkflowBranchResultError(code, details); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);

/** Canonical artifact bytes; these are evidence digests, never an execution or approval permit. */
export function workflowGitPacketJson(value: unknown): string {
  function normalized(item: unknown, depth: number): unknown {
    requireCapture(depth <= 32, "workflow_result_packet_too_deep");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(entry => normalized(entry, depth + 1));
    requireCapture(typeof item === "object" && item !== null, "workflow_result_packet_invalid");
    return Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compare(a, b))
      .map(([key, entry]) => [key, normalized(entry, depth + 1)]));
  }
  return JSON.stringify(normalized(value, 0));
}

export function workflowGitPacketDigest(value: unknown): string { return `wgp1_${digest(workflowGitPacketJson(value))}`; }

function immutable<T>(value: T): T {
  const copy = JSON.parse(workflowGitPacketJson(value)) as T;
  function freeze(item: unknown): void {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
  }
  freeze(copy); return copy;
}

export { immutable as workflowGitPacketSnapshot };

/** Reopen sealed evidence from Git/artifact storage. A digest or ref alone is not trusted authority. */
export async function inspectSealedWorkflowBranchResult(root: string, result: WorkflowBranchResult): Promise<void> {
  const packet = result.packet;
  requireCapture(result.status === "sealed" && packet?.schemaVersion === 1 && packet.kind === "workflow_branch_result"
    && result.packetDigest === workflowGitPacketDigest(packet) && result.commit === packet.commit && result.tree === packet.tree
    && result.resultRef === packet.resultRef && packet.context.lineage.canonicalWorkspaceRoot === root
    && packet.context.scope.repository.root === root && packet.baseCommit === packet.context.scope.baseCommit
    && workflowGitPacketJson(packet.policy) === workflowGitPacketJson(WORKFLOW_BRANCH_CAPTURE_POLICY), "workflow_branch_packet_mismatch");
  validateContext(packet.context);
  validateTerminal(packet.context, packet.terminal);
  const scope = packet.context.scope;
  requireCapture(packet.resultRef === `refs/ling/workflow/results/${scope.roundId}/${scope.stepId}/${scope.generation}-${scope.worktreeId}`
    && oid.test(packet.commit) && oid.test(packet.tree) && packet.commit.length === scope.baseCommit.length
    && packet.tree.length === scope.baseCommit.length, "workflow_branch_packet_mismatch");
  requireCapture(await workflowGitResultRef(root, packet.resultRef) === packet.commit, "workflow_branch_sealed_ref_changed");
  const parents = text((await workflowGit(root, ["rev-list", "--parents", "-n", "1", packet.commit])).stdout).trim().split(" ");
  requireCapture(parents.length === 2 && parents[0] === packet.commit && parents[1] === packet.baseCommit
    && text((await workflowGit(root, ["rev-parse", "--verify", `${packet.commit}^{tree}`])).stdout).trim() === packet.tree,
  "workflow_branch_packet_mismatch");
  const base = await readBaseTree(root, packet.baseCommit), next = await readBaseTree(root, packet.tree);
  const allowed = new Set(packet.context.allowedPaths), changes: WorkflowBranchChangedPath[] = [];
  let changedBytes = 0;
  for (const path of [...new Set([...base.keys(), ...next.keys()])].sort(compare)) {
    const previous = base.get(path), current = next.get(path);
    if (previous?.blob === current?.blob && previous?.mode === current?.mode) continue;
    requireCapture(allowed.has(path), "workflow_branch_unauthorized_path", { path });
    const before = previous ? await readBlobVersion(root, previous, path) : undefined;
    const after = current ? await readBlobVersion(root, current, path) : undefined;
    changedBytes += (before?.sizeBytes ?? 0) + (after?.sizeBytes ?? 0);
    requireCapture(changedBytes <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxChangedBytes, "workflow_branch_changed_budget_exceeded");
    changes.push({ path, change: !before ? "add" : !after ? "delete" : "modify", ...(before ? { before } : {}), ...(after ? { after } : {}) });
  }
  requireCapture(workflowGitPacketJson(changes) === workflowGitPacketJson(packet.changedPaths), "workflow_branch_packet_mismatch");
  const patch = (await workflowGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--full-index", "--text",
    packet.baseCommit, packet.tree, "--"])).stdout;
  requireCapture(patch.length <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxPatchBytes && packet.patchDigest === digest(patch)
    && packet.patch === text(patch) && packet.discovery.trackedPaths === base.size && packet.discovery.files === next.size
    && workflowGitPacketJson(packet.discovery.newPaths) === workflowGitPacketJson([...next.keys()].filter(path => !base.has(path)).sort(compare))
    && packet.discovery.ignoredResidue.length === 0 && packet.discovery.excludedPaths.length === 0,
  "workflow_branch_packet_mismatch");
}

export async function captureWorkflowBranchResult(input: WorkflowBranchCaptureContext & {
  readonly assertTerminalQuiescent: AssertWorkflowBranchTerminalQuiescent;
  readonly journal: WorkflowGitRefJournal;
}): Promise<WorkflowBranchResult> {
  requireCapture(typeof input.assertTerminalQuiescent === "function", "workflow_branch_terminal_authority_required");
  requireCapture(typeof input.journal?.recordIntent === "function" && typeof input.journal?.recordReceipt === "function",
    "workflow_branch_journal_required");
  const context = immutable({ scope: input.scope, receipt: input.receipt, lineage: input.lineage,
    allowedPaths: [...input.allowedPaths].sort(compare) });
  validateContext(context);
  const terminal = immutable(await input.assertTerminalQuiescent(context));
  validateTerminal(context, terminal);
  const assertCurrent = async () => {
    const current = await input.assertTerminalQuiescent(context);
    validateTerminal(context, current);
    requireCapture(workflowGitPacketDigest(current) === workflowGitPacketDigest(terminal), "workflow_branch_terminal_basis_changed");
  };
  return withWorkflowGitRepositoryLock(context.scope.repository, async () => {
    const repository = await inspectCaptureSource(context);
    const base = await readBaseTree(repository.root, context.scope.baseCommit);
    const first = await discover(repository.root, context.scope.baseCommit.length);
    await rejectIgnoredResidue(repository.root, base, first);
    const changes = await collectChanges(repository.root, base, first, context.allowedPaths);
    const resultRef = `refs/ling/workflow/results/${context.scope.roundId}/${context.scope.stepId}/${context.scope.generation}-${context.scope.worktreeId}`;
    requireCapture(await workflowGitResultRef(repository.root, resultRef) === null, "workflow_branch_result_ref_exists", { resultRef });
    const temporary = await mkdtemp(join(await realpath(tmpdir()), "ling-workflow-index-"));
    try {
      const indexFile = join(temporary, "index");
      await workflowGit(repository.root, ["read-tree", context.scope.baseCommit], { indexFile });
      const updates: string[] = [];
      for (const change of changes) {
        if (change.after) {
          const bytes = first.files.get(change.path)!.bytes;
          const written = text((await workflowGit(repository.root, ["hash-object", "-w", "--no-filters", "--stdin"], { input: bytes })).stdout).trim();
          requireCapture(written === change.after.blob, "workflow_branch_blob_mismatch");
        }
        updates.push(`${change.after?.mode ?? "0"} ${change.after?.blob ?? "0".repeat(context.scope.baseCommit.length)}\t${change.path}\0`);
      }
      if (updates.length) await workflowGit(repository.root, ["update-index", "-z", "--index-info"], { indexFile, input: Buffer.from(updates.join("")) });
      const tree = text((await workflowGit(repository.root, ["write-tree"], { indexFile })).stdout).trim();
      requireCapture(oid.test(tree), "workflow_branch_tree_invalid");
      await inspectWorkflowGitTree(repository.root, tree);
      const patchBytes = (await workflowGit(repository.root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
        "--full-index", "--text", context.scope.baseCommit, tree, "--"])).stdout;
      requireCapture(patchBytes.length <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxPatchBytes, "workflow_branch_patch_budget_exceeded");
      const commit = text((await workflowGit(repository.root, ["commit-tree", tree, "-p", context.scope.baseCommit],
        { input: Buffer.from(`Ling workflow branch result\n\n${workflowGitPacketDigest({ context, terminal, tree })}\n`) })).stdout).trim();
      requireCapture(oid.test(commit), "workflow_branch_commit_invalid");
      const packet = immutable<WorkflowBranchResultPacketV1>({ schemaVersion: 1, kind: "workflow_branch_result", context, terminal,
        policy: WORKFLOW_BRANCH_CAPTURE_POLICY, baseCommit: context.scope.baseCommit, commit, tree, resultRef, changedPaths: changes,
        patch: text(patchBytes), patchDigest: digest(patchBytes), discovery: { trackedPaths: base.size, files: first.files.size,
          directories: first.directories.length, newPaths: [...first.files.keys()].filter(path => !base.has(path)).sort(compare),
          ignoredResidue: [], excludedPaths: [] } });
      const packetDigest = workflowGitPacketDigest(packet);
      const effect: WorkflowGitRefEffect = immutable({ kind: "branch_capture", roundId: context.scope.roundId, generation: context.scope.generation,
        commonDir: repository.commonDir, ref: resultRef, beforeCommit: null, afterCommit: commit, tree, packetDigest, packetJson: workflowGitPacketJson(packet) });
      await sealWorkflowGitResultRef(repository, effect, input.journal, async () => {
        await assertCurrent();
        await inspectCaptureSource(context);
        const final = await discover(repository.root, context.scope.baseCommit.length);
        await rejectIgnoredResidue(repository.root, base, final);
        requireCapture(first.fingerprint === final.fingerprint, "workflow_branch_source_changed");
      });
      return Object.freeze({ status: "sealed", packet, packetDigest, commit, tree, resultRef });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

/** Named refs are the recoverable Git effect. Caller must hold the repository lock. */
export async function sealWorkflowGitResultRef(repository: WorkflowGitRepository, effect: WorkflowGitRefEffect,
  journal: WorkflowGitRefJournal, assertCurrent: () => Promise<void>): Promise<void> {
  requireCapture(effect.commonDir === repository.commonDir && /^refs\/ling\/workflow\/(?:results|candidates)\//u.test(effect.ref)
    && oid.test(effect.afterCommit) && oid.test(effect.tree) && effect.beforeCommit === null, "workflow_result_ref_effect_invalid");
  await assertCurrent();
  const intentId = await journal.recordIntent(effect);
  requireCapture(identity(intentId), "workflow_result_intent_invalid");
  let effectStarted = false;
  try {
    await assertCurrent();
    effectStarted = true;
    await workflowGit(repository.root, ["update-ref", "--no-deref", effect.ref, effect.afterCommit, "0".repeat(effect.afterCommit.length)]);
    const observedCommit = await workflowGitResultRef(repository.root, effect.ref);
    requireCapture(observedCommit === effect.afterCommit, "workflow_result_ref_changed");
    await journal.recordReceipt({ intentId, effect, outcome: "confirmed", observedCommit });
  } catch (cause) {
    let observedCommit: string | null = null, observed = false;
    try { observedCommit = await workflowGitResultRef(repository.root, effect.ref); observed = true; } catch { /* Retain an unknown effect. */ }
    const outcome = !effectStarted || observed && observedCommit === null ? "blocked" : "effect_unknown";
    try { await journal.recordReceipt({ intentId, effect, outcome, observedCommit }); }
    catch (receiptCause) { throw new WorkflowBranchResultError("workflow_result_receipt_unconfirmed", { intentId, effect, observedCommit }, { cause: receiptCause }); }
    throw new WorkflowBranchResultError(outcome === "blocked" ? "workflow_result_seal_blocked" : "workflow_result_effect_unknown",
      { intentId, effect, observedCommit }, { cause });
  }
}

export async function workflowGitResultRef(root: string, ref: string): Promise<string | null> {
  requireCapture(/^refs\/ling\/workflow\/(?:results|candidates)\/[A-Za-z0-9_/-]+$/u.test(ref), "workflow_result_ref_invalid");
  try {
    const value = text((await workflowGit(root, ["rev-parse", "--verify", "--quiet", ref])).stdout).trim();
    requireCapture(oid.test(value), "workflow_result_ref_invalid"); return value;
  } catch (error) { if ((error as { readonly code?: unknown })?.code === 1) return null; throw error; }
}

function validateContext(context: WorkflowBranchCaptureContext): void {
  const { scope, receipt, lineage } = context;
  requireCapture(scope && receipt && lineage && [scope.roundId, scope.stepId, scope.worktreeId].every(value => identifier.test(value))
    && Number.isSafeInteger(scope.generation) && scope.generation > 0 && oid.test(scope.baseCommit), "workflow_branch_scope_invalid");
  requireCapture(receipt.worktreeId === scope.worktreeId && receipt.executionRoot === scope.executionRoot
    && receipt.branchRef === scope.branchRef && receipt.baseCommit === scope.baseCommit
    && receipt.commonDir === scope.repository.commonDir && scope.executionRoot === join(scope.worktreeRoot, scope.worktreeId)
    && scope.branchRef === `refs/heads/ling/workflow/${scope.roundId}/${scope.stepId}/${scope.generation}-${scope.worktreeId}`,
  "workflow_branch_receipt_mismatch");
  requireCapture([lineage.workflowId, lineage.canonicalWorkspaceId, lineage.planId, lineage.planDigest, lineage.bindingId,
    lineage.runId, lineage.workUnitId, lineage.attemptId, lineage.runtimeInstanceId, lineage.fencingToken].every(identity)
    && lineage.canonicalWorkspaceRoot === scope.repository.root && Number.isSafeInteger(lineage.bindingRevision) && lineage.bindingRevision >= 0
    && lineage.startOwner?.schemaVersion === 1 && lineage.startOwner.phase === "linked"
    && [lineage.startOwner.taskId, lineage.startOwner.leaseId, lineage.startOwner.authorityBasis].every(identity), "workflow_branch_lineage_invalid");
  requireCapture(context.allowedPaths.length <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxEntries
    && new Set(context.allowedPaths).size === context.allowedPaths.length && context.allowedPaths.every(safeWorkflowGitPath),
  "workflow_branch_allowed_paths_invalid");
}

function validateTerminal(context: WorkflowBranchCaptureContext, terminal: WorkflowBranchTerminalEvidence): void {
  requireCapture(terminal && workflowGitPacketDigest(terminal.lineage) === workflowGitPacketDigest(context.lineage)
    && ["succeeded", "failed", "cancelled"].includes(terminal.outcome)
    && [terminal.terminalArtifactRef, terminal.quiescenceArtifactRef, terminal.toolCompletionArtifactRef, terminal.outputPacketArtifactRef].every(identity)
    && Array.isArray(terminal.contextArtifactRefs) && terminal.contextArtifactRefs.length <= 128 && terminal.contextArtifactRefs.every(identity)
    && Array.isArray(terminal.validations) && terminal.validations.length <= 128
    && Array.isArray(terminal.unknownEffects) && terminal.unknownEffects.length === 0, "workflow_branch_terminal_evidence_invalid");
  for (const validation of terminal.validations) requireCapture(identity(validation.id) && Array.isArray(validation.command)
    && validation.command.length > 0 && validation.command.length <= 128 && validation.command.every(identity)
    && validation.executionRoot === context.scope.executionRoot && identity(validation.inputScopeDigest)
    && Number.isSafeInteger(validation.exitCode) && identity(validation.artifactRef), "workflow_branch_validation_evidence_invalid");
}

async function inspectCaptureSource(context: WorkflowBranchCaptureContext): Promise<WorkflowGitRepository> {
  const { scope, receipt } = context;
  const current = await inspectWorkflowGitRepository(scope.executionRoot, { allowDirtyCandidate: true });
  requireCapture(current.commonDir === scope.repository.commonDir && current.head === scope.baseCommit && current.branchRef === scope.branchRef
    && current.configurationDigest === scope.repository.configurationDigest && current.commonDevice === scope.repository.commonDevice
    && current.commonInode === scope.repository.commonInode && current.rootDevice === receipt.rootDevice && current.rootInode === receipt.rootInode,
  "workflow_branch_source_identity_changed");
  return current;
}

interface BaseFile { readonly mode: "100644" | "100755"; readonly blob: string }
interface CapturedFile { readonly bytes: Buffer; readonly version: WorkflowBranchFileVersion; readonly identity: string }
interface Discovery { readonly files: ReadonlyMap<string, CapturedFile>; readonly directories: readonly string[]; readonly fingerprint: string }

async function readBaseTree(root: string, commit: string): Promise<Map<string, BaseFile>> {
  await inspectWorkflowGitTree(root, commit);
  const entries = text((await workflowGit(root, ["ls-tree", "-r", "-z", "--full-tree", commit])).stdout).split("\0").filter(Boolean);
  const files = new Map<string, BaseFile>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), [mode, type, blob] = entry.slice(0, tab).split(" "), path = entry.slice(tab + 1);
    requireCapture(tab > 0 && (mode === "100644" || mode === "100755") && type === "blob" && oid.test(blob) && safeWorkflowGitPath(path),
      "workflow_branch_base_tree_invalid");
    files.set(path, { mode, blob });
  }
  return files;
}

async function discover(root: string, oidLength: number): Promise<Discovery> {
  const files = new Map<string, CapturedFile>(), directories: string[] = [], names = new Map<string, string>();
  let entries = 0, scannedBytes = 0;
  async function walk(directory: string, parent: string, depth: number): Promise<void> {
    requireCapture(depth <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxDepth, "workflow_branch_depth_budget_exceeded");
    const initial = await lstat(directory, { bigint: true });
    requireCapture(initial.isDirectory() && !initial.isSymbolicLink() && await realpath(directory) === directory,
      "workflow_branch_directory_unsafe", { path: parent });
    const children = (await readdir(directory, { encoding: "buffer" })).map(bytes => text(bytes)).sort(compare);
    for (const name of children) {
      if (!parent && name === ".git") continue;
      const path = parent ? `${parent}/${name}` : name;
      requireCapture(++entries <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxEntries, "workflow_branch_entry_budget_exceeded");
      requireCapture(safeWorkflowGitPath(path), "workflow_branch_path_unsupported", { path });
      const folded = path.normalize("NFC").toLowerCase();
      requireCapture(!names.has(folded) || names.get(folded) === path, "workflow_branch_ambiguous_case_path", { path });
      names.set(folded, path);
      const absolute = join(root, path), stat = await lstat(absolute, { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) { directories.push(path); await walk(absolute, path, depth + 1); continue; }
      requireCapture(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && (stat.mode & 0o7000n) === 0n,
        "workflow_branch_special_file_unsupported", { path });
      requireCapture(stat.size <= BigInt(WORKFLOW_BRANCH_CAPTURE_POLICY.maxFileBytes), "workflow_branch_file_budget_exceeded", { path });
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        requireCapture(await realpath(dirname(absolute)) === dirname(absolute), "workflow_branch_directory_unsafe", { path });
        const before = await handle.stat({ bigint: true });
        requireCapture(statIdentity(before) === statIdentity(stat), "workflow_branch_source_changed", { path });
        const bytes = Buffer.alloc(Number(stat.size) + 1); let count = 0;
        while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
        requireCapture(count === Number(stat.size) && statIdentity(await handle.stat({ bigint: true })) === statIdentity(before)
          && statIdentity(await lstat(absolute, { bigint: true })) === statIdentity(before)
          && await realpath(dirname(absolute)) === dirname(absolute), "workflow_branch_source_changed", { path });
        const content = bytes.subarray(0, count);
        scannedBytes += count;
        requireCapture(scannedBytes <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxScannedBytes, "workflow_branch_scan_budget_exceeded");
        const blob = createHash(oidLength === 40 ? "sha1" : "sha256").update(`blob ${count}\0`).update(content).digest("hex");
        files.set(path, { bytes: content, identity: statIdentity(before), version: { mode: (stat.mode & 0o111n) === 0n ? "100644" : "100755",
          blob, sha256: digest(content), sizeBytes: count } });
      } finally { await handle.close(); }
    }
    requireCapture(statIdentity(await lstat(directory, { bigint: true })) === statIdentity(initial), "workflow_branch_source_changed", { path: parent });
  }
  await walk(root, "", 0);
  return { files, directories, fingerprint: workflowGitPacketDigest({ directories,
    files: [...files].map(([path, file]) => ({ path, identity: file.identity, ...file.version })) }) };
}

function statIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function rejectIgnoredResidue(root: string, base: ReadonlyMap<string, BaseFile>, discovery: Discovery): Promise<void> {
  const trackedDirectories = new Set<string>();
  for (const path of base.keys()) { let parent = dirname(path); while (parent !== ".") { trackedDirectories.add(parent); parent = dirname(parent); } }
  const candidates = [...discovery.files.keys()].filter(path => !base.has(path))
    .concat(discovery.directories.filter(path => !trackedDirectories.has(path)).map(path => `${path}/`));
  if (!candidates.length) return;
  let bytes: Buffer;
  // check-ignore rejects literal pathspec magic; ./ keeps stdin names literal even when they start with :.
  try { bytes = (await workflowGit(root, ["--no-literal-pathspecs", "check-ignore", "--no-index", "-z", "--stdin"],
    { input: Buffer.from(`${candidates.map(path => `./${path}`).join("\0")}\0`) })).stdout; }
  catch (error) { if ((error as { readonly code?: unknown })?.code === 1) return; throw error; }
  const ignored = text(bytes).split("\0").filter(Boolean).map(path => path.replace(/^\.\//u, ""));
  requireCapture(ignored.length === 0, "workflow_branch_ignored_residue", { paths: ignored });
}

async function collectChanges(root: string, base: ReadonlyMap<string, BaseFile>, discovery: Discovery,
  allowedPaths: readonly string[]): Promise<WorkflowBranchChangedPath[]> {
  const allowed = new Set(allowedPaths), changes: WorkflowBranchChangedPath[] = [];
  const allowedDirectories = new Set<string>();
  for (const path of [...base.keys(), ...allowed]) {
    let parent = dirname(path);
    while (parent !== ".") { allowedDirectories.add(parent); parent = dirname(parent); }
  }
  for (const path of discovery.directories) requireCapture(allowedDirectories.has(path), "workflow_branch_unauthorized_path", { path });
  let changedBytes = 0;
  for (const path of [...new Set([...base.keys(), ...discovery.files.keys()])].sort(compare)) {
    const previous = base.get(path), next = discovery.files.get(path)?.version;
    if (previous?.blob === next?.blob && previous?.mode === next?.mode) continue;
    requireCapture(allowed.has(path), "workflow_branch_unauthorized_path", { path });
    const afterBytes = discovery.files.get(path)?.bytes;
    if (afterBytes) assertText(afterBytes, path);
    let before: WorkflowBranchFileVersion | undefined;
    if (previous) before = await readBlobVersion(root, previous, path);
    changedBytes += (before?.sizeBytes ?? 0) + (next?.sizeBytes ?? 0);
    requireCapture(changedBytes <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxChangedBytes, "workflow_branch_changed_budget_exceeded");
    changes.push({ path, change: !previous ? "add" : !next ? "delete" : "modify", ...(before ? { before } : {}), ...(next ? { after: next } : {}) });
  }
  return changes;
}

async function readBlobVersion(root: string, file: BaseFile, path: string): Promise<WorkflowBranchFileVersion> {
  const size = Number(text((await workflowGit(root, ["cat-file", "-s", file.blob])).stdout).trim());
  requireCapture(Number.isSafeInteger(size) && size >= 0 && size <= WORKFLOW_BRANCH_CAPTURE_POLICY.maxFileBytes,
    "workflow_branch_file_budget_exceeded", { path });
  const bytes = (await workflowGit(root, ["cat-file", "blob", file.blob])).stdout;
  requireCapture(bytes.length === size, "workflow_branch_base_blob_changed");
  assertText(bytes, path);
  return { ...file, sha256: digest(bytes), sizeBytes: size };
}

function text(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { throw new WorkflowBranchResultError("workflow_branch_non_utf8_unsupported", {}, { cause }); }
}
function assertText(bytes: Buffer, path: string): void {
  requireCapture(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text(bytes)), "workflow_branch_binary_unsupported", { path });
}
