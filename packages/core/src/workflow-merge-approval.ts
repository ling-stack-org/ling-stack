import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkflowMergeApprovalPayloadV1, WorkflowMergeTargetSnapshotV1 } from "./workflow-merge-types.js";
import { workflowIsolationDigest as digest, workflowIsolationRecord as record } from "./workflow-isolation.js";

/** Preserve the existing Git repository basis format shared with the daemon. */
export function workflowMergeTargetSnapshotDigest(repository: WorkflowMergeTargetSnapshotV1): string {
  return `wgr1_${createHash("sha256").update(JSON.stringify({
    root: repository.root, commonDir: repository.commonDir, gitDir: repository.gitDir,
    head: repository.head, branchRef: repository.branchRef, configurationDigest: repository.configurationDigest,
    rootDevice: repository.rootDevice, rootInode: repository.rootInode,
    commonDevice: repository.commonDevice, commonInode: repository.commonInode, dirty: repository.dirty,
    ...(repository.hostState ? { hostState: repository.hostState } : {}),
  })).digest("hex")}`;
}

export function workflowMergeApprovalFingerprint(value: Omit<WorkflowMergeApprovalPayloadV1, "fingerprint">): string {
  return digest(value, "wma1_");
}

export function isWorkflowMergeTargetSnapshot(value: unknown): value is WorkflowMergeTargetSnapshotV1 {
  if (!record(value) || Object.keys(value).length !== (value.hostState === undefined ? 11 : 12) || value.dirty !== false
    || ![value.root, value.commonDir, value.gitDir].every(path => typeof path === "string"
      && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f]/u.test(path))
    || typeof value.head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.head)
    || typeof value.branchRef !== "string" || !value.branchRef.startsWith("refs/heads/")
    || /[\x00-\x20\x7f]/u.test(value.branchRef)
    || typeof value.configurationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.configurationDigest)) return false;
  return [value.rootDevice, value.rootInode, value.commonDevice, value.commonInode]
    .every(part => typeof part === "string" && /^[0-9]+$/u.test(part))
    && (value.hostState === undefined || record(value.hostState) && Object.keys(value.hostState).length === 3
      && value.hostState.root === join(value.root as string, ".ling-stack")
      && [value.hostState.rootDevice, value.hostState.rootInode].every(part => typeof part === "string" && /^[0-9]+$/u.test(part)));
}
