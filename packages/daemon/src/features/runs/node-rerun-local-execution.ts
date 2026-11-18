import type { NodeRerunPreparedTargetV1 } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";

/** Local history cannot become absence merely because a live Run entry was removed. */
export function observePreparedNodeRerunExecution(activeRuns: ActiveRunRegistry,
  target: NodeRerunPreparedTargetV1): "absent" | "present" | "unknown" {
  if (activeRuns.get(target.runId)) return "present";
  const observed = activeRuns.observeAttemptStop({ runId: target.runId, ...target.fence });
  return observed.localExecution === "draining" ? "present" : observed.localExecution === "drained" ? "unknown" : "absent";
}
