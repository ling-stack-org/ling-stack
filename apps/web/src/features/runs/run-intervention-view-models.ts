import type { StatusTone } from "../../shared/ui/index.js";
import type { RunIntervention } from "../../types.js";

const statusTones: Readonly<Record<RunIntervention["status"], StatusTone>> = {
  cancelled: "neutral",
  cancelling_source: "warning",
  failed: "danger",
  queued: "info",
  started: "success",
  starting_continuation: "info",
};

export function runInterventionStatusTone(status: RunIntervention["status"]): StatusTone {
  return statusTones[status];
}
