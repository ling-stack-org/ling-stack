import type { ApprovalRequest, ListApprovalRequestsOptions } from "../../approval-types.js";
import {
  type LingThread,
  type LingThreadMetadata,
  type LingTurn,
  type ListLingThreadsOptions,
  type ListLingTurnsOptions,
  type ListRunsOptions,
  type RunArtifact,
  type RunSession,
} from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { omitUndefined, stringifyJson } from "./helpers.js";
import { runActivityAt } from "./run-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteLingThreadMetadataCoordinatorPorts {
  readonly getLingThread: (threadId: string) => LingThread | undefined;
  readonly getLingTurn: (turnId: string) => LingTurn | undefined;
  readonly getRun: (runId: string) => RunSession | undefined;
  readonly listLingThreads: (options: ListLingThreadsOptions) => LingThread[];
  readonly listLingTurns: (options: ListLingTurnsOptions) => LingTurn[];
  readonly listRuns: (options: ListRunsOptions) => RunSession[];
  readonly listApprovalRequests: (options: ListApprovalRequestsOptions) => ApprovalRequest[];
  readonly listArtifacts: (runId: string) => RunArtifact[];
  readonly readLatestRunActionActivityAt: (runIds: readonly string[]) => string | undefined;
}

export class SqliteLingThreadMetadataCoordinator {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingThreadMetadataCoordinatorPorts,
  ) {}

  rebuildLingThreadMetadata(threadId: string, now: string): LingThread | undefined {
    const thread = this.ports.getLingThread(threadId);
    if (!thread) {
      return undefined;
    }
    const runs = this.ports.listRuns({ threadId, limit: 200 });
    const turns = this.ports.listLingTurns({ threadId, limit: 500 });
    const approvalsById = new Map<string, ApprovalRequest>();
    for (const run of runs) {
      for (const approval of this.ports.listApprovalRequests({ runId: run.id, limit: 500 })) {
        approvalsById.set(approval.id, approval);
      }
    }
    if (thread.workflowStepId) {
      for (const approval of this.ports.listApprovalRequests({ workflowStepId: thread.workflowStepId, limit: 500 })) {
        approvalsById.set(approval.id, approval);
      }
    }
    const approvals = [...approvalsById.values()];
    const artifacts = runs.flatMap((run) => this.ports.listArtifacts(run.id));
    const latestTurn = [...turns].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    const latestFailedRun = runs
      .filter((run) => run.status === "failed")
      .sort((left, right) => compareIsoDesc(runActivityAt(left), runActivityAt(right)) || right.id.localeCompare(left.id))[0];
    const latestArtifact = [...artifacts]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
    const activityTimestamps = [
      thread.createdAt,
      thread.updatedAt,
      thread.archivedAt,
      ...turns.flatMap((turn) => [turn.createdAt, turn.updatedAt, turn.completedAt]),
      ...runs.flatMap((run) => [run.createdAt, run.startedAt, run.endedAt, run.updatedAt]),
      ...approvals.flatMap((approval) => [approval.createdAt, approval.resolvedAt]),
      ...artifacts.map((artifact) => artifact.createdAt),
      this.ports.readLatestRunActionActivityAt(runs.map((run) => run.id)),
    ];
    const metadata: LingThreadMetadata = omitUndefined({
      schemaVersion: 1 as const,
      summary: summarizeLingThreadForMetadata(thread, latestTurn),
      pinnedAt: thread.pinnedAt,
      lastTurnId: latestTurn?.id,
      lastActivityAt: maxIsoTimestamp(activityTimestamps),
      pendingApprovalCount: approvals.filter((approval) => approval.status === "pending").length,
      blockedCount: (thread.status === "blocked" ? 1 : 0) + turns.filter((turn) => turn.status === "blocked").length,
      failedAttemptCount: runs.filter((run) => run.status === "failed").length,
      artifactCount: artifacts.length,
      latestFailureRunId: latestFailedRun?.id,
      latestEvidenceArtifactId: latestArtifact?.id,
      rebuiltAt: now,
    });
    this.context.database
      .prepare("UPDATE ling_threads SET metadata_json = ? WHERE id = ?")
      .run(stringifyJson(metadata), threadId);
    return this.ports.getLingThread(threadId);
  }

  rebuildLingThreadMetadataForRun(runId: string, now: string): LingThread | undefined {
    const run = this.ports.getRun(runId);
    return run?.threadId ? this.rebuildLingThreadMetadata(run.threadId, now) : undefined;
  }

  tryRebuildLingThreadMetadata(threadId: string | undefined, now: string): void {
    if (!threadId) {
      return;
    }
    try {
      this.rebuildLingThreadMetadata(threadId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  tryRebuildLingThreadMetadataForRun(runId: string | undefined, now: string): void {
    if (!runId) {
      return;
    }
    try {
      this.rebuildLingThreadMetadataForRun(runId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  tryRebuildLingThreadMetadataForTurn(turnId: string | undefined, now: string): void {
    if (!turnId) {
      return;
    }
    try {
      const turn = this.ports.getLingTurn(turnId);
      this.tryRebuildLingThreadMetadata(turn?.threadId, now);
    } catch {
      // Metadata is a rebuildable read cache; source mutations must remain authoritative.
    }
  }

  tryRebuildLingThreadMetadataForApproval(approval: ApprovalRequest | undefined, now: string): void {
    if (!approval) {
      return;
    }
    this.tryRebuildLingThreadMetadataForRun(approval.runId, now);
    if (approval.workflowStepId) {
      try {
        for (const thread of this.ports.listLingThreads({ workflowStepId: approval.workflowStepId, includeArchived: true, limit: 500 })) {
          this.tryRebuildLingThreadMetadata(thread.id, now);
        }
      } catch {
        // Metadata is a rebuildable read cache; source mutations must remain authoritative.
      }
    }
  }
}

function summarizeLingThreadForMetadata(thread: LingThread, latestTurn: LingTurn | undefined): string | undefined {
  const source = latestTurn?.title || thread.title || thread.objective;
  if (!source.trim()) {
    return undefined;
  }
  const redacted = String(redactSecrets(source));
  const compact = redacted.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, 160) : undefined;
}

function maxIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0];
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}
