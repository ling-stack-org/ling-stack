import { createHash } from "node:crypto";
import type { AutomationMonitorCondition, AutomationMonitorSource } from "./automation-types.js";

/** JSON facts collected by a monitor source. Timestamps are kept outside this value. */
export type AutomationMonitorSnapshotBody = Record<string, unknown>;

export interface AutomationMonitorSnapshot {
  readonly automationId: string;
  readonly fingerprint: string;
  readonly snapshot: AutomationMonitorSnapshotBody;
  readonly updatedAt: string;
}

export interface RecordAutomationMonitorSnapshotInput {
  readonly automationId: string;
  readonly fingerprint: string;
  readonly snapshot: AutomationMonitorSnapshotBody;
}

export interface RecordAutomationMonitorSnapshotResult {
  readonly changed: boolean;
  readonly previous?: AutomationMonitorSnapshot;
  readonly snapshot: AutomationMonitorSnapshot;
}

/** Stable source-plus-facts identity used for monitor idempotency. */
export function automationMonitorFingerprint(
  source: AutomationMonitorSource,
  snapshot: AutomationMonitorSnapshotBody,
): string {
  return createHash("sha256").update(stableJson({ source, snapshot }), "utf8").digest("hex");
}

/** Serialize monitor facts after validating that they are JSON values. */
export function serializeAutomationMonitorSnapshot(snapshot: AutomationMonitorSnapshotBody): string {
  return stableJson(snapshot);
}

/** Evaluate a monitor condition against the current source facts. */
export function matchesAutomationMonitorCondition(
  condition: AutomationMonitorCondition,
  snapshot: AutomationMonitorSnapshotBody,
): boolean {
  switch (condition.kind) {
    case "any_change":
      return true;
    case "count_above": {
      const value = snapshot[condition.field];
      return typeof value === "number" && Number.isFinite(value) && value > condition.threshold;
    }
    case "status_matches": {
      const value = snapshot.status;
      if (typeof value === "string") {
        return condition.statuses.includes(value);
      }
      const statuses = snapshot.statuses;
      if (Array.isArray(statuses)
        && statuses.some((status): status is string => typeof status === "string" && condition.statuses.includes(status))) {
        return true;
      }
      const statusCounts = snapshot.statusCounts;
      return statusCounts !== null
        && typeof statusCounts === "object"
        && !Array.isArray(statusCounts)
        && Object.entries(statusCounts as Record<string, unknown>)
          .some(([status, count]) => condition.statuses.includes(status)
            && typeof count === "number"
            && Number.isFinite(count)
            && count > 0);
    }
    case "error_present": {
      const errorPresent = snapshot.errorPresent;
      if (typeof errorPresent === "boolean") {
        return errorPresent;
      }
      const errorCount = snapshot.errorCount;
      if (typeof errorCount === "number") {
        return errorCount > 0;
      }
      const errors = snapshot.errors;
      return Array.isArray(errors) && errors.length > 0;
    }
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Automation monitor snapshots must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Automation monitor snapshots must contain JSON values");
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Automation monitor snapshots must contain JSON values");
}
