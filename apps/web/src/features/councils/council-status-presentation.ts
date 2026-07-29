import type { StatusTone } from "../../shared/ui/index.js";
import type { AiCouncilStatus } from "../../types.js";

export interface CouncilStatusPresentation {
  readonly labelKey: "Active" | "Paused" | "Archived";
  readonly tone: StatusTone;
}

const COUNCIL_STATUS_PRESENTATION: Record<AiCouncilStatus, CouncilStatusPresentation> = {
  active: { labelKey: "Active", tone: "success" },
  paused: { labelKey: "Paused", tone: "warning" },
  archived: { labelKey: "Archived", tone: "neutral" },
};

export function councilStatusPresentation(status: AiCouncilStatus): CouncilStatusPresentation {
  return COUNCIL_STATUS_PRESENTATION[status];
}
