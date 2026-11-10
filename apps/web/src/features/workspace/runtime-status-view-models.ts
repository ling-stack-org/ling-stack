import type { StatusTone } from "../../shared/ui/index.js";
import type { ResourceLease, RuntimeSemaphoreSlot, WorkUnit } from "../../types.js";

export type RuntimeStatusLabelKey =
  | "Active"
  | "Waiting for input"
  | "Cancelling"
  | "Cancelled"
  | "Claimed"
  | "Completed"
  | "Expired"
  | "Failed"
  | "Queued"
  | "Running"
  | "Stale"
  | "Succeeded"
  | "Waiting for approval";

export interface RuntimeStatusPresentation {
  readonly labelKey: RuntimeStatusLabelKey;
  readonly tone: StatusTone;
}

const workUnitStatusPresentations = {
  queued: { labelKey: "Queued", tone: "info" },
  claimed: { labelKey: "Claimed", tone: "info" },
  running: { labelKey: "Running", tone: "info" },
  waiting_for_approval: { labelKey: "Waiting for approval", tone: "warning" },
  waiting_for_input: { labelKey: "Waiting for input", tone: "neutral" },
  cancelling: { labelKey: "Cancelling", tone: "warning" },
  succeeded: { labelKey: "Succeeded", tone: "success" },
  failed: { labelKey: "Failed", tone: "danger" },
  cancelled: { labelKey: "Cancelled", tone: "neutral" },
  stale: { labelKey: "Stale", tone: "warning" },
} as const satisfies Record<WorkUnit["status"], RuntimeStatusPresentation>;

const resourceStatusPresentations = {
  active: { labelKey: "Active", tone: "success" },
  released: { labelKey: "Completed", tone: "neutral" },
  expired: { labelKey: "Expired", tone: "warning" },
} as const satisfies Record<ResourceLease["status"], RuntimeStatusPresentation>;

export function workUnitStatusPresentation(status: WorkUnit["status"]): RuntimeStatusPresentation {
  return workUnitStatusPresentations[status];
}

export function resourceLeaseStatusPresentation(status: ResourceLease["status"]): RuntimeStatusPresentation {
  return resourceStatusPresentations[status];
}

export function runtimeSemaphoreStatusPresentation(
  status: RuntimeSemaphoreSlot["status"],
): RuntimeStatusPresentation {
  return resourceStatusPresentations[status];
}
