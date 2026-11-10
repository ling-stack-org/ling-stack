import { resolve } from "node:path";
import {
  digestHarnessToolValue,
  type HarnessToolExecutionRecoveryCursor,
  type ReconciledHarnessToolExecutionOutcome,
  type RunStore,
} from "@ling-stack/core";
import type { HarnessToolExecutionV1 } from "@ling-stack/contracts";
import { isRecord } from "../../../shared/validation.js";
import {
  classifyFileMutationRecovery,
  type FileMutationRecoveryBasis,
} from "./executors/file-mutation.js";

export interface HarnessToolStartupRecoveryResult {
  readonly scanned: number;
  readonly updated: number;
  readonly skipped: number;
  readonly pages: number;
}

/** Synchronously drain bounded discovery pages before any recovery dispatch can observe this Store. */
export function reconcileHarnessToolExecutionsAtStartup(input: {
  readonly cwd: string;
  readonly store: RunStore;
  readonly now: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}): HarnessToolStartupRecoveryResult {
  let cursor: HarnessToolExecutionRecoveryCursor | undefined;
  let scanned = 0;
  let updated = 0;
  let pages = 0;
  do {
    input.signal?.throwIfAborted();
    const page = input.store.reconcileAbandonedHarnessToolExecutionsPage({
      now: input.now,
      limit: input.limit,
      cursor,
      classify: (execution) => classifyAbandonedFileMutation(input.store, input.cwd, execution),
    });
    scanned += page.scanned;
    updated += page.updated.length;
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor);
  return { scanned, updated, skipped: scanned - updated, pages };
}

function classifyAbandonedFileMutation(
  store: RunStore,
  workspaceCwd: string,
  execution: HarnessToolExecutionV1,
): ReconciledHarnessToolExecutionOutcome | undefined {
  if (execution.executorKind !== "apply_patch" && execution.executorKind !== "write") return undefined;
  const run = store.getRun(execution.runId);
  if (!run || resolve(run.cwd) !== resolve(workspaceCwd)) return undefined;
  const policyArtifact = store.getArtifact(execution.policySnapshotArtifactId);
  if (!policyArtifact) return undefined;
  const payload = policyArtifact?.sealedPayload;
  if (!isRecord(payload) || payload.schemaVersion !== 1 || payload.executorKind !== execution.executorKind
    || !isRecord(payload.effectivePolicySnapshot)) return undefined;
  const basis = readRecoveryBasis(payload.fileMutationRecovery);
  const allowedWritePaths = readStringList(payload.effectivePolicySnapshot.allowedWritePaths);
  if (!basis || !allowedWritePaths) return undefined;
  const outcome = classifyFileMutationRecovery({ cwd: run.cwd, allowedWritePaths, basis });
  const resultSummary = {
    status: outcome === "applied" ? "succeeded" : outcome === "not_applied" ? "failed" : "unknown_outcome",
    outcome,
    reason: "expired_file_mutation_claim_reconciled_from_pre_post_hashes",
    touchedPaths: [...basis.touchedPaths],
  };
  const evidenceArtifactIds = store.listArtifacts(run.id)
    .filter((artifact) => artifact.id === policyArtifact.id
      || artifact.path.startsWith(`.ling-stack/provenance/${run.id}/${execution.id}/`)
      || Boolean(execution.approvalId && artifact.path.includes(`/actions/${execution.approvalId}/patch-result.json`)))
    .map((artifact) => artifact.id);
  return {
    nextState: outcome === "applied" ? "succeeded" : outcome === "not_applied" ? "failed" : "unknown_outcome",
    resultDigest: digestHarnessToolValue(resultSummary),
    resultSummary,
    evidenceArtifactIds,
    ...(outcome === "applied"
      ? {}
      : { failureCode: outcome === "not_applied" ? "tool.executor_failed" as const : "tool.unknown_side_effect_outcome" as const }),
  };
}

function readRecoveryBasis(value: unknown): FileMutationRecoveryBasis | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.touchedPaths)
    || !value.touchedPaths.every((path) => typeof path === "string") || !Array.isArray(value.operations)) return undefined;
  const operations = value.operations.flatMap((operation) => {
    if (!isRecord(operation) || typeof operation.path !== "string"
      || !["add", "update", "delete"].includes(String(operation.kind))
      || (operation.oldSha256 !== undefined && typeof operation.oldSha256 !== "string")
      || (operation.newSha256 !== undefined && typeof operation.newSha256 !== "string")) return [];
    return [{
      path: operation.path,
      kind: operation.kind as "add" | "update" | "delete",
      ...(typeof operation.oldSha256 === "string" ? { oldSha256: operation.oldSha256 } : {}),
      ...(typeof operation.newSha256 === "string" ? { newSha256: operation.newSha256 } : {}),
    }];
  });
  if (operations.length !== value.operations.length) return undefined;
  return { schemaVersion: 1, touchedPaths: [...value.touchedPaths], operations };
}

function readStringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}
