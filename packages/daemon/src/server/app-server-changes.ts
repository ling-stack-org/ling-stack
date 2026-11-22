import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type {
  CodeAssessmentSnapshot,
  LingAppServerApplyChangesResult,
  LingAppServerCaptureChangesResult,
  LingAppServerChangeRecoveryPreview,
  LingAppServerPreviewChangeRecoveryParams,
  LingAppServerReadChangesResult,
} from "@ling-stack/contracts";
import type { LingTurn, RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { captureCodeAssessmentSnapshot, isSensitiveAssessmentPath } from "../features/code-assessments/snapshot.js";
import {
  buildTurnWorkspaceChangesResponse,
  recoverTurnWorkspaceChanges,
  RunWorkspaceRecoveryError,
  withWorkspaceRecoveryLock,
} from "../features/runs/workspace-change-recovery.js";
import { assertWorktreeIdle } from "../features/workspaces/worktree-mutation.js";

const digestPattern = /^[a-f0-9]{64}$/u;
const maxResultBytes = 112 * 1024;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function summarizeCandidate(cwd: string, snapshot: CodeAssessmentSnapshot): LingAppServerCaptureChangesResult {
  if (!snapshot.headSha) throw new HttpError(409, "candidate_unavailable", "The worktree has no committed candidate baseline.");
  return {
    cwd,
    candidate: {
      workspaceId: cwd,
      candidateDigest: snapshot.digest, filePaths: snapshot.files.map(file => file.path),
    },
    coverage: snapshot.coverage, headCommit: snapshot.headSha,
  };
}

export async function captureAppServerChanges(cwd: string): Promise<LingAppServerCaptureChangesResult> {
  return summarizeCandidate(cwd, await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" }));
}

export async function readAppServerChanges(cwd: string, input: Record<string, unknown>): Promise<LingAppServerReadChangesResult> {
  const { candidateDigest, offset = 0, limit = 20 } = input;
  if (typeof candidateDigest !== "string" || !digestPattern.test(candidateDigest)
    || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, "invalid_params", "Supply a candidate digest and valid file pagination.");
  }
  const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
  if (snapshot.digest !== candidateDigest) throw stale("The worktree changed since the candidate was captured.");
  const summary = summarizeCandidate(cwd, snapshot);
  const files: LingAppServerReadChangesResult["files"][number][] = [];
  const result = { ...summary, candidate: { ...summary.candidate, filePaths: undefined },
    files, exclusions: snapshot.exclusions.slice(0, 20), exclusionCount: snapshot.exclusions.length,
    totalFileCount: snapshot.totalFileCount };
  let remaining = maxResultBytes - responseBytes(result);
  let nextOffset = offset;
  for (const file of snapshot.files.slice(offset, offset + limit)) {
    let entry: LingAppServerReadChangesResult["files"][number] = file;
    if (remaining < responseBytes(entry) + 1) {
      if (files.length) break;
      const { diff: _diff, ...metadata } = file;
      entry = { ...metadata, diffOmitted: "frame_limit" };
    }
    files.push(entry);
    remaining -= responseBytes(entry) + 1;
    nextOffset++;
  }
  return { ...result, ...(nextOffset < snapshot.files.length ? { nextOffset } : {}) };
}

export async function previewAppServerChangeRecovery(
  store: RunStore, input: Record<string, unknown>,
): Promise<LingAppServerChangeRecoveryPreview> {
  const { turn, action } = recoveryTarget(store, input);
  return withWorkspaceRecoveryLock(store.paths.cwd, () => previewRecovery(store, turn, action));
}

export async function applyAppServerChanges(store: RunStore, input: Record<string, unknown>): Promise<LingAppServerApplyChangesResult> {
  const { turn, action } = recoveryTarget(store, input);
  const { expectedRevision, idempotencyKey, confirmed } = input;
  if (typeof expectedRevision !== "string" || !digestPattern.test(expectedRevision)
    || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200
    || /[\r\n\0]/u.test(idempotencyKey) || confirmed !== true) {
    throw new HttpError(400, "invalid_params", "Confirm the recovery preview with its revision and a request key.");
  }
  const receiptId = `change_recovery_${hash(idempotencyKey)}`;
  const fingerprint = hash([turn.id, action, expectedRevision]);
  const checkReceipt = () => {
    const stored = store.getAppServerState("change_recovery_request", receiptId);
    if (stored && stored.payload !== fingerprint) {
      throw Object.assign(new Error("The change recovery key belongs to a different request."),
        { jsonRpcCode: -32031, code: "idempotency_conflict" });
    }
    return stored;
  };
  checkReceipt();
  await recoverTurnWorkspaceChanges(store, turn, action, receiptId, {
    validate: async () => {
      const preview = await previewRecovery(store, turn, action);
      if (preview.expectedRevision !== expectedRevision) throw stale("The candidate or recovery basis changed after preview.");
    },
    assertCurrent: (cwd) => {
      assertRecoveryIdle(store, cwd);
      if (!checkReceipt() && !store.putAppServerState({
        kind: "change_recovery_request", recordId: receiptId, expectedRevision: 0, payload: fingerprint,
      }, new Date().toISOString())) throw stale("The change recovery request changed during admission.");
    },
  });
  if (!checkReceipt()) throw new HttpError(409, "unknown_outcome", "The accepted recovery request could not be confirmed.");
  return { cwd: store.paths.cwd, turnId: turn.id, action, receiptId, state: action === "undo" ? "undone" : "applied" };
}

function recoveryTarget(store: RunStore, input: Record<string, unknown>) {
  const { threadId, turnId, action } = input;
  if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId
    || action !== "undo" && action !== "reapply") throw new HttpError(400, "invalid_params", "Supply the Thread, Turn and recovery action.");
  const turn = store.getLingTurn(turnId);
  if (!turn || turn.threadId !== threadId || !store.getLingThread(threadId)) {
    throw new HttpError(404, "workspace_binding_invalid", "The Turn does not belong to this Thread.");
  }
  const runs = store.listLingTurnRuns(turnId);
  if (runs.some(link => {
    const run = store.getRun(link.runId);
    return !run || run.cwd !== store.paths.cwd;
  })) throw new HttpError(409, "workspace_binding_invalid", "Recovery requires a Turn in the bound project checkout.");
  return { turn, action } as const;
}

async function previewRecovery(
  store: RunStore, turn: LingTurn, action: LingAppServerPreviewChangeRecoveryParams["action"],
): Promise<LingAppServerChangeRecoveryPreview> {
  const cwd = store.paths.cwd;
  assertRecoveryIdle(store, cwd);
  const { dev, ino } = statSync(cwd, { bigint: true });
  const changes = await buildTurnWorkspaceChangesResponse(store, turn);
  if (changes.review?.state !== "exact" || changes.files.some(file => isSensitiveAssessmentPath(file.path))
    || !(action === "undo" ? changes.canUndo : changes.canReapply)) {
    throw new HttpError(409, "workspace_changes_unavailable", "Recovery requires the complete reviewed Turn patch in its expected state.");
  }
  const candidate = await captureAppServerChanges(cwd);
  if (candidate.coverage !== "complete") {
    throw new HttpError(409, "candidate_incomplete", "Recovery requires complete coverage of the current candidate.");
  }
  const expectedRevision = hash([cwd, String(dev), String(ino), turn.id, action, candidate.candidate.candidateDigest,
    changes.runIds, changes.review.revision, changes.updatedAt]);
  const preview = { ...candidate, action, changes, expectedRevision };
  if (responseBytes(preview) > maxResultBytes) throw new HttpError(413, "change_preview_limit", "The recovery preview exceeds the response limit.");
  assertRecoveryIdle(store, cwd);
  return preview;
}

function assertRecoveryIdle(store: RunStore, cwd: string): void {
  if (cwd !== store.paths.cwd || realpathSync(cwd) !== cwd) {
    throw new RunWorkspaceRecoveryError(409, "workspace_binding_invalid", "The recovery checkout identity changed.");
  }
  store.assertWorkspaceSnapshotFence(cwd);
  assertWorktreeIdle(store, cwd);
}

function stale(message: string) {
  return Object.assign(new Error(message), { jsonRpcCode: -32030, code: "stale_revision" });
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
