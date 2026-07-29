import type { StatusTone } from "../../shared/ui/index.js";
import type { RunStatus } from "../../types.js";

export type ChannelActiveStatusInput =
  | { readonly kind: "run"; readonly status: RunStatus }
  | { readonly kind: "pending-approval" }
  | { readonly kind: "provider-blocked" };

export interface ChannelActiveStatusPresentation {
  readonly labelKey:
    | "Blocked"
    | "Cancelled"
    | "Failed"
    | "Queued"
    | "Running"
    | "Succeeded"
    | "Waiting for approval";
  readonly tone: StatusTone;
}

const RUN_STATUS_PRESENTATION: Record<RunStatus, ChannelActiveStatusPresentation> = {
  queued: { labelKey: "Queued", tone: "info" },
  running: { labelKey: "Running", tone: "info" },
  waiting_for_approval: { labelKey: "Waiting for approval", tone: "warning" },
  succeeded: { labelKey: "Succeeded", tone: "success" },
  failed: { labelKey: "Failed", tone: "danger" },
  cancelled: { labelKey: "Cancelled", tone: "neutral" },
};

export function channelActiveStatusPresentation(
  input: ChannelActiveStatusInput,
): ChannelActiveStatusPresentation {
  if (input.kind === "run") {
    return RUN_STATUS_PRESENTATION[input.status];
  }
  if (input.kind === "pending-approval") {
    return { labelKey: "Waiting for approval", tone: "warning" };
  }
  return { labelKey: "Blocked", tone: "warning" };
}
