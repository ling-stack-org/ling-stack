import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { LingAppServerApplyChangeTransferResult } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, type RunStore } from "@ling-stack/core";
import {
  hashRecoveryContent,
  type RecoveryIntentFile,
} from "../runs/workspace-change-recovery.js";
import { workflowGit } from "./managed-worktrees.js";

export const WORKTREE_PATCH_RECEIPT_PREFIX = "worktree_patch_";
export const WORKTREE_PATCH_MAX_TEXT_BYTES = 1024 * 1024;

export interface WorktreePatchReceipt {
  readonly fingerprint: string;
  readonly targetPath: string;
  readonly targetIdentity: string;
  readonly targetHead: string;
  readonly files: readonly RecoveryIntentFile[];
  readonly result: Omit<LingAppServerApplyChangeTransferResult, "state">;
  readonly state?: LingAppServerApplyChangeTransferResult["state"];
}

export function readWorktreePatchReceipt(store: RunStore, id: string) {
  const record = store.getAppServerState("change_transfer_request", id);
  return record ? { receipt: record.payload as WorktreePatchReceipt, revision: record.revision } : undefined;
}

export function worktreeDirectoryIdentity(path: string): string {
  const directory = lstatSync(path, { bigint: true });
  if (!directory.isDirectory() || realpathSync(path) !== path) throw new Error("The worktree directory changed.");
  return [directory.dev, directory.ino, directory.birthtimeNs].join(":");
}

/** Read the exact text image without following links or treating invalid bytes as text. */
export function readWorktreePatchText(root: string, path: string): string | undefined {
  const target = join(root, path);
  const segments = path.split("/");
  let directory = root;
  for (const part of segments.slice(0, -1)) {
    directory = join(directory, part);
    if (!lstatSync(directory).isDirectory()) throw new Error("A patch parent is not a directory.");
  }
  const entry = lstatSync(target, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > WORKTREE_PATCH_MAX_TEXT_BYTES) {
    throw new Error("The patch target is not a bounded regular file.");
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size > WORKTREE_PATCH_MAX_TEXT_BYTES) {
      throw new Error("The patch target changed during inspection.");
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size !== opened.size || fstatSync(fd).mtimeMs !== opened.mtimeMs) throw new Error("The patch target changed during inspection.");
    return decodeWorktreePatchText(bytes.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}

export function decodeWorktreePatchText(bytes: Buffer): string {
  if (bytes.length > WORKTREE_PATCH_MAX_TEXT_BYTES || bytes.includes(0)) throw new Error("The patch target is not bounded text.");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function settleWorktreePatch(
  store: RunStore, id: string, receipt: WorktreePatchReceipt, revision: number,
  state: LingAppServerApplyChangeTransferResult["state"],
): LingAppServerApplyChangeTransferResult {
  const committed = store.putAppServerState({
    kind: "change_transfer_request", recordId: id, expectedRevision: revision, payload: { ...receipt, state },
  }, new Date().toISOString());
  if (!committed) throw new Error("The worktree patch receipt changed during settlement.");
  return { ...receipt.result, state };
}

/** Settle only observed filesystem outcomes after interruption. The recovery path never writes files. */
export async function recoverWorktreePatch(store: RunStore): Promise<void> {
  const fence = store.getWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID);
  const id = fence.ownerRequestId;
  if (!id?.startsWith(WORKTREE_PATCH_RECEIPT_PREFIX)) return;
  const retained = readWorktreePatchReceipt(store, id);
  if (!retained) throw new Error("The worktree patch receipt is missing.");
  const { receipt, revision } = retained;
  if (!receipt.state) {
    const state = await observeWorktreePatch(receipt);
    settleWorktreePatch(store, id, receipt, revision, state);
  }
  store.releaseWorkspaceSnapshotFence(DEFAULT_WORKSPACE_ID, id, new Date().toISOString(), fence.epoch);
}

async function observeWorktreePatch(receipt: WorktreePatchReceipt): Promise<LingAppServerApplyChangeTransferResult["state"]> {
  try {
    if (worktreeDirectoryIdentity(receipt.targetPath) !== receipt.targetIdentity) return "unknown";
    const { stdout } = await workflowGit(receipt.targetPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (stdout.toString().trim() !== receipt.targetHead || worktreeDirectoryIdentity(receipt.targetPath) !== receipt.targetIdentity) return "unknown";
    const observed = receipt.files.map(file => hashRecoveryContent(readWorktreePatchText(receipt.targetPath, file.path)));
    if (receipt.files.every((file, index) => file.afterSha256 === observed[index])) return "applied";
    if (receipt.files.every((file, index) => file.beforeSha256 === observed[index])) return "not_applied";
  } catch {
    // The stored request remains readable when its target is unavailable.
  }
  return "unknown";
}
