import type { StatusTone } from "../../shared/ui/index.js";
import type { RunStatus } from "../../types.js";

export interface RunStatusPresentation {
  readonly labelKey: "Queued" | "Running" | "Waiting for approval" | "Execution yielded" | "Succeeded" | "Failed" | "Cancelled";
  readonly tone: StatusTone;
}

const RUN_STATUS_PRESENTATION: Record<RunStatus, RunStatusPresentation> = {
  queued: { labelKey: "Queued", tone: "info" },
  running: { labelKey: "Running", tone: "info" },
  waiting_for_approval: { labelKey: "Waiting for approval", tone: "warning" },
  yielded: { labelKey: "Execution yielded", tone: "neutral" },
  succeeded: { labelKey: "Succeeded", tone: "success" },
  failed: { labelKey: "Failed", tone: "danger" },
  cancelled: { labelKey: "Cancelled", tone: "neutral" },
};

export function runStatusPresentation(status: RunStatus): RunStatusPresentation {
  return RUN_STATUS_PRESENTATION[status];
}
