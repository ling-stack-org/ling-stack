import type { StatusTone } from "../../shared/ui/index.js";
import type { AiTeammateStatus } from "../../types.js";

export interface TeammateStatusPresentation {
  readonly labelKey: "Active" | "Paused" | "Disabled";
  readonly tone: StatusTone;
}

const TEAMMATE_STATUS_PRESENTATION: Record<AiTeammateStatus, TeammateStatusPresentation> = {
  active: { labelKey: "Active", tone: "success" },
  paused: { labelKey: "Paused", tone: "warning" },
  disabled: { labelKey: "Disabled", tone: "neutral" },
};

export function teammateStatusPresentation(status: AiTeammateStatus): TeammateStatusPresentation {
  return TEAMMATE_STATUS_PRESENTATION[status];
}
