import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { applyPatch, parsePatch, type StructuredPatch } from "diff";
import type {
  CodeAssessmentSnapshot,
  CodeAssessmentSnapshotFile,
  LingAppServerApplyChangeTransferParams,
  LingAppServerApplyChangeTransferResult,
  LingAppServerCaptureChangesResult,
  LingAppServerChangeHunk,
  LingAppServerChangeTransferPreview,
  LingAppServerChangeWorktree,
  LingAppServerPreviewChangeTransferParams,
} from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import {
  assertNoInternalPatchPaths,
  assertNoSymlinkEscapes,
  assertPatchPathsWithinAllowedWritePaths,
} from "../features/runs/patch-actions.js";
import { commitRecovery, recoveryIntentFiles, type RecoveryPreflight } from "../features/runs/workspace-change-recovery.js";
import { workflowGit } from "../features/workspaces/managed-worktrees.js";
import { assertWorktreeIdle, coordinateWorktreeMutation } from "../features/workspaces/worktree-mutation.js";
import {
  decodeWorktreePatchText,
  readWorktreePatchReceipt,
  readWorktreePatchText,
  recoverWorktreePatch,
  settleWorktreePatch,
  WORKTREE_PATCH_MAX_TEXT_BYTES,
  WORKTREE_PATCH_RECEIPT_PREFIX,
  worktreeDirectoryIdentity,
  type WorktreePatchReceipt,
} from "../features/workspaces/worktree-patch-recovery.js";
import { isRecord } from "../shared/validation.js";
import { refreshAppServerWorktree } from "./app-server-worktrees.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function summarizeAppServerCandidate(
  cwd: string, snapshot: CodeAssessmentSnapshot, sourceWorktree?: LingAppServerChangeWorktree,
): LingAppServerCaptureChangesResult {
  if (!snapshot.headSha) throw new HttpError(409, "candidate_unavailable", "The worktree has no committed candidate baseline.");
  return {
    cwd,
    candidate: {
      workspaceId: cwd, ...(sourceWorktree ? { worktreeId: hash(sourceWorktree) } : {}),
      candidateDigest: snapshot.digest, filePaths: snapshot.files.map(file => file.path),
    },
    coverage: snapshot.coverage, headCommit: snapshot.headSha,
  };
}

export function readChangeWorktree(value: unknown): LingAppServerChangeWorktree {
  if (!isRecord(value) || (value.ownerKind !== "channel" && value.ownerKind !== "teammate")
    || typeof value.ownerId !== "string" || !value.ownerId.trim() || value.ownerId.length > 200) {
    throw new HttpError(400, "invalid_params", "Supply the managed worktree owner kind and ID.");
  }
  return { ownerKind: value.ownerKind, ownerId: value.ownerId };
}

export async function resolveChangeWorktree(store: RunStore, target: LingAppServerChangeWorktree): Promise<string> {
  const { entry } = await refreshAppServerWorktree(store, target);
  if (entry.status !== "ready" || entry.initialization?.status === "running") {
    throw new HttpError(409, "worktree_conflict", "The managed worktree must be ready.");
  }
  return realpathSync(entry.path);
}

export function describeChangeHunks(file: CodeAssessmentSnapshotFile): readonly LingAppServerChangeHunk[] {
  const patch = transferablePatch(file);
  return patch ? identifyHunks(file, patch) : [];
}

function identifyHunks(file: CodeAssessmentSnapshotFile, patch: StructuredPatch): readonly LingAppServerChangeHunk[] {
  return patch.hunks.map(({ oldStart, oldLines, newStart, newLines }, index) => ({
    id: hash([file.path, file.contentDigest, index]), oldStart, oldLines, newStart, newLines,
  }));
}

function transferablePatch(file: CodeAssessmentSnapshotFile): StructuredPatch | undefined {
  if (file.redacted || file.originalPath || !["modified", "added", "deleted", "untracked"].includes(file.kind)) return undefined;
  try {
    const [patch, extra] = parsePatch(file.diff);
    if (!patch?.hunks.length || extra || patch.isBinary || patch.isRename || patch.isCopy
      || (file.kind === "modified" && patch.oldMode !== patch.newMode)
      || (file.kind === "added" && patch.newMode !== "100644")
      || (file.kind === "deleted" && patch.oldMode !== "100644" && patch.oldMode !== "100755")) return undefined;
    return patch;
  } catch {
    return undefined;
  }
}

function readTransferParams(record: Record<string, unknown>): LingAppServerPreviewChangeTransferParams {
  const { candidateDigest, hunkIds } = record;
  if (typeof candidateDigest !== "string" || !digestPattern.test(candidateDigest)
    || !Array.isArray(hunkIds) || hunkIds.length < 1 || hunkIds.length > 128
    || hunkIds.some(id => typeof id !== "string" || !digestPattern.test(id)) || new Set(hunkIds).size !== hunkIds.length) {
    throw new HttpError(400, "invalid_params", "Supply a candidate digest and distinct hunk IDs from changes/read.");
  }
  return {
    action: "apply", candidateDigest, hunkIds: [...hunkIds].sort(),
    ...(record.sourceWorktree !== undefined ? { sourceWorktree: readChangeWorktree(record.sourceWorktree) } : {}),
    targetWorktree: readChangeWorktree(record.targetWorktree),
  };
}

export async function previewAppServerChangeTransfer(store: RunStore, record: Record<string, unknown>): Promise<LingAppServerChangeTransferPreview> {
  store.assertWorkspaceSnapshotFence(store.paths.cwd);
  return (await prepareTransfer(store, readTransferParams(record))).preview;
}

export async function applyAppServerChangeTransfer(store: RunStore, record: Record<string, unknown>): Promise<LingAppServerApplyChangeTransferResult> {
  const target = readTransferParams(record);
  const { idempotencyKey, expectedRevision } = record;
  if (record.confirmed !== true || typeof expectedRevision !== "string" || !digestPattern.test(expectedRevision)
    || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200 || /[\r\n\0]/u.test(idempotencyKey)) {
    throw new HttpError(400, "invalid_params", "Confirm the transfer with the preview revision and a request key.");
  }
  const request: LingAppServerApplyChangeTransferParams = { ...target, idempotencyKey, expectedRevision, confirmed: true };
  const id = WORKTREE_PATCH_RECEIPT_PREFIX + hash(idempotencyKey);
  const fingerprint = hash(request);
  return coordinateWorktreeMutation(store, async () => {
    await recoverWorktreePatch(store);
    const retained = readWorktreePatchReceipt(store, id);
    if (retained?.receipt && retained.receipt.fingerprint !== fingerprint) {
      throw Object.assign(new Error("The change transfer key belongs to a different request."),
        { jsonRpcCode: -32031, code: "idempotency_conflict" });
    }
    if (retained?.receipt.state) return { ...retained.receipt.result, state: retained.receipt.state };
    store.assertWorkspaceSnapshotFence(store.paths.cwd);

    const prepared = await prepareTransfer(store, request);
    assertConfirmed(prepared.preview, expectedRevision);
    const { targetPath, targetIdentity, preflight, preview } = prepared;
    const receipt: WorktreePatchReceipt = {
      fingerprint, targetPath, targetIdentity, targetHead: preview.targetHeadCommit, files: recoveryIntentFiles(preflight),
      result: { cwd: store.paths.cwd, action: "apply", targetWorktree: request.targetWorktree, receiptId: id, paths: preflight.paths },
    };
    const revision = retained?.revision ?? store.putAppServerState({
      kind: "change_transfer_request", recordId: id, expectedRevision: 0, payload: receipt,
    }, new Date().toISOString())?.record.revision;
    if (revision === undefined) throw new HttpError(409, "stale_revision", "The transfer request changed during admission.");
    const epoch = store.acquireWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, id, new Date().toISOString());
    let dispatched = false;
    try {
      const current = await prepareTransfer(store, request);
      assertConfirmed(current.preview, expectedRevision);
      const fence = store.getWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID);
      if (fence.ownerRequestId !== id || fence.epoch !== epoch) throw new Error("The transfer lost its worktree fence.");
      assertWorktreeIdle(store, targetPath);
      for (const path of current.preflight.paths) {
        if (readWorktreePatchText(targetPath, path) !== current.preflight.before.get(path)) throw conflict(path);
      }
      dispatched = true;
      commitRecovery(targetPath, current.preflight);
      const result = settleWorktreePatch(store, id, receipt, revision, "applied");
      store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, id, new Date().toISOString(), epoch);
      return result;
    } catch (error) {
      if (!dispatched) {
        settleWorktreePatch(store, id, receipt, revision, "not_applied");
        store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, id, new Date().toISOString(), epoch);
        throw error;
      }
      await recoverWorktreePatch(store);
      const reconciled = readWorktreePatchReceipt(store, id)?.receipt;
      if (!reconciled?.state) throw new HttpError(409, "unknown_outcome", "The worktree transfer could not be reconciled.");
      return { ...reconciled.result, state: reconciled.state };
    }
  });
}

function assertConfirmed(preview: LingAppServerChangeTransferPreview, expectedRevision: string): void {
  if (preview.expectedRevision !== expectedRevision) {
    throw Object.assign(new Error("The source candidate, selection or target worktree changed after preview."),
      { jsonRpcCode: -32030, code: "stale_revision" });
  }
}

async function prepareTransfer(store: RunStore, input: LingAppServerPreviewChangeTransferParams) {
  const cwd = store.paths.cwd;
  const [sourcePath, targetPath] = await Promise.all([
    input.sourceWorktree ? resolveChangeWorktree(store, input.sourceWorktree) : Promise.resolve(cwd),
    resolveChangeWorktree(store, input.targetWorktree),
  ]);
  if (sourcePath === targetPath) throw new HttpError(400, "invalid_params", "Select a different target worktree.");
  const sourceIdentity = worktreeDirectoryIdentity(sourcePath);
  const targetIdentity = worktreeDirectoryIdentity(targetPath);
  assertWorktreeIdle(store, targetPath);
  const [source, target] = await Promise.all([sourcePath, targetPath].map(path =>
    captureCodeAssessmentSnapshot(path, { type: "working_tree" })));
  if (!source?.headSha || !target?.headSha || source.digest !== input.candidateDigest
    || source.coverage !== "complete" || target.coverage !== "complete") {
    throw new HttpError(409, "candidate_stale", "The transfer requires the current source candidate and complete worktree coverage.");
  }
  const selected = new Set(input.hunkIds);
  const changedTarget = new Set(target.files.flatMap(file => file.originalPath ? [file.path, file.originalPath] : [file.path]));
  const selection: LingAppServerChangeTransferPreview["selection"][number][] = [];
  const before = new Map<string, string | undefined>();
  const after = new Map<string, string | undefined>();
  const allowed = store.getApprovalPolicy().allowedWritePaths;
  for (const file of source.files) {
    const patch = transferablePatch(file);
    if (!patch) continue;
    const hunks = identifyHunks(file, patch);
    const indices = hunks.flatMap((hunk, index) => selected.delete(hunk.id) ? [index] : []);
    if (!indices.length) continue;
    if (selection.length >= 20) throw new HttpError(400, "invalid_params", "A transfer can change at most 20 files.");
    const operation = file.kind;
    if (operation !== "modified" && indices.length !== hunks.length) {
      throw new HttpError(400, "invalid_params", "File creation and deletion require selecting the whole file patch.");
    }
    if (changedTarget.has(file.path)) throw conflict(file.path);
    assertNoInternalPatchPaths([file.path], targetPath);
    assertPatchPathsWithinAllowedWritePaths([file.path], targetPath, allowed);
    assertNoSymlinkEscapes([file.path], targetPath, allowed);
    const baseline = await readBlob(sourcePath, source.headSha, file.path);
    const current = readWorktreePatchText(targetPath, file.path);
    if (current !== baseline || (["added", "untracked"].includes(operation) && baseline !== undefined)
      || (["modified", "deleted"].includes(operation) && baseline === undefined)) throw conflict(file.path);
    const updated = operation === "deleted" ? undefined
      : applyPatch(baseline ?? "", { ...patch, hunks: indices.map(index => patch.hunks[index]!) }, { autoConvertLineEndings: false });
    const full = applyPatch(baseline ?? "", patch, { autoConvertLineEndings: false });
    const sourceText = readWorktreePatchText(sourcePath, file.path);
    if (updated === false || full === false || (operation === "deleted" ? full !== "" || sourceText !== undefined : full !== sourceText)
      || updated === current) throw conflict(file.path);
    before.set(file.path, current);
    after.set(file.path, updated);
    selection.push({ path: file.path, hunkIds: indices.map(index => hunks[index]!.id) });
  }
  if (selected.size) throw new HttpError(409, "candidate_stale", "A selected hunk is unavailable in the current candidate.");
  if (worktreeDirectoryIdentity(sourcePath) !== sourceIdentity || worktreeDirectoryIdentity(targetPath) !== targetIdentity) {
    throw new HttpError(409, "worktree_conflict", "A worktree changed during inspection.");
  }
  assertWorktreeIdle(store, targetPath);
  const preflight: RecoveryPreflight = { paths: [...before.keys()], before, after };
  const summary = summarizeAppServerCandidate(cwd, source, input.sourceWorktree);
  const preview: LingAppServerChangeTransferPreview = {
    ...summary, candidate: { ...summary.candidate, filePaths: preflight.paths },
    action: "apply", targetWorktree: input.targetWorktree, targetCandidateDigest: target.digest, targetHeadCommit: target.headSha, selection,
    expectedRevision: hash([sourcePath, sourceIdentity, targetPath, targetIdentity, input.sourceWorktree,
      input.targetWorktree, source.digest, target.digest, selection, allowed, recoveryIntentFiles(preflight)]),
  };
  return { preview, targetPath, targetIdentity, preflight };
}

async function readBlob(cwd: string, commit: string, path: string): Promise<string | undefined> {
  const { stdout } = await workflowGit(cwd, ["ls-tree", "-z", commit, "--", path]);
  if (!stdout.length) return undefined;
  const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/u.exec(stdout.toString());
  if (!match) throw conflict(path);
  const object = match[1]!;
  const size = await workflowGit(cwd, ["cat-file", "-s", object]);
  const bytes = Number(size.stdout.toString().trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WORKTREE_PATCH_MAX_TEXT_BYTES) throw conflict(path);
  return decodeWorktreePatchText((await workflowGit(cwd, ["cat-file", "blob", object])).stdout);
}

function conflict(path: string): HttpError {
  return new HttpError(409, "worktree_conflict", `The selected patch no longer matches a regular text file: ${path}`);
}
