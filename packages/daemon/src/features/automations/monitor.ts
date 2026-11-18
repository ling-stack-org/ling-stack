import type {
  AutomationDefinition,
  AutomationMonitorSnapshotBody,
  AutomationMonitorSource,
  RunStore,
} from "@ling-stack/core";

export interface ReadAutomationMonitorSnapshotInput {
  readonly store: RunStore;
  readonly automation: AutomationDefinition;
  readonly now: string;
}

/**
 * Read bounded local facts for one monitor tick. The returned body excludes the
 * wall clock so an unchanged source remains idempotent across polling ticks.
 */
export function readAutomationMonitorSnapshot(
  input: ReadAutomationMonitorSnapshotInput,
): AutomationMonitorSnapshotBody {
  const source = input.automation.trigger.type === "monitor" ? input.automation.trigger.source : undefined;
  if (!source) {
    throw new Error("Automation monitor source is unavailable");
  }
  switch (source.kind) {
    case "doctor_summary":
      return readDoctorSummary(input.store);
    case "runtime_stuck_work":
      return readRuntimeStuckWork(input.store);
    case "pending_approvals":
      return readPendingApprovals(input.store, source, input.now);
    case "external_work":
      return readExternalWork(input.store, source.channelId ?? input.automation.channelId);
    case "github_ci":
      return readGithubCi(input.store, source.channelId);
  }
}

function readDoctorSummary(store: RunStore): AutomationMonitorSnapshotBody {
  const workUnits = store.listWorkUnits({ limit: 500 });
  const pendingApprovals = store.listApprovalRequests({ status: "pending", limit: 500 });
  const externalWork = store.listExternalWorkRecords({ limit: 500 });
  const statusCounts = countStatuses(workUnits.map((workUnit) => workUnit.status));
  const errorCount = (statusCounts.failed ?? 0) + (statusCounts.stale ?? 0);
  return {
    activeCount: (statusCounts.queued ?? 0) + (statusCounts.claimed ?? 0) + (statusCounts.running ?? 0)
      + (statusCounts.waiting_for_approval ?? 0) + (statusCounts.waiting_for_input ?? 0),
    pendingApprovalCount: pendingApprovals.length,
    externalWorkCount: externalWork.length,
    statusCounts,
    errorCount,
    errorPresent: errorCount > 0,
  };
}

function readRuntimeStuckWork(store: RunStore): AutomationMonitorSnapshotBody {
  const workUnits = store.listWorkUnits({ limit: 500 });
  const stuck = workUnits.filter((workUnit) => workUnit.status === "stale");
  return {
    count: stuck.length,
    ids: stuck.map((workUnit) => workUnit.id).sort(),
    statuses: stuck.map((workUnit) => workUnit.status).sort(),
    errorCount: stuck.length,
    errorPresent: stuck.length > 0,
  };
}

function readPendingApprovals(
  store: RunStore,
  source: Extract<AutomationMonitorSource, { readonly kind: "pending_approvals" }>,
  now: string,
): AutomationMonitorSnapshotBody {
  const pending = store.listApprovalRequests({ status: "pending", limit: 500 });
  const cutoff = source.olderThanMs === undefined ? undefined : Date.parse(now) - source.olderThanMs;
  const selected = pending.filter((approval) => cutoff === undefined || Date.parse(approval.createdAt) <= cutoff);
  const oldestCreatedAt = selected.map((approval) => approval.createdAt).sort()[0];
  return {
    count: selected.length,
    ids: selected.map((approval) => approval.id).sort(),
    statuses: selected.map((approval) => approval.status).sort(),
    ...(oldestCreatedAt ? { oldestCreatedAt } : {}),
  };
}

function readExternalWork(store: RunStore, channelId: string | undefined): AutomationMonitorSnapshotBody {
  const records = store.listExternalWorkRecords({ channelId, limit: 500 });
  const statuses = records.map((record) => record.item.state).sort();
  const errorCount = statuses.filter((status) => /fail|error|blocked/i.test(status)).length;
  return {
    count: records.length,
    ids: records.map((record) => record.id).sort(),
    statuses,
    errorCount,
    errorPresent: errorCount > 0,
  };
}

function readGithubCi(store: RunStore, channelId: string): AutomationMonitorSnapshotBody {
  const triage = store.listExternalWorkCiTriage({ channelId, limit: 500 });
  const statuses = triage.map((item) => item.status).sort();
  const errorCount = statuses.filter((status) => /fail|error|blocked/i.test(status)).length;
  return {
    count: triage.length,
    ids: triage.map((item) => item.id).sort(),
    statuses,
    errorCount,
    errorPresent: errorCount > 0,
  };
}

function countStatuses(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
