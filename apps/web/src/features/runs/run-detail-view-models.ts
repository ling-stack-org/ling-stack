import type { StatusTone } from "../../shared/ui/index.js";
import type { ApprovalRequest, RunEventEnvelope, RunSession } from "../../types.js";
import { runStatusTone } from "./run-list-view-models.js";

export function deriveRunPrimaryState(run: RunSession | undefined, approvals: readonly ApprovalRequest[]): {
  readonly label: string;
  readonly tone: StatusTone;
} {
  if (!run) return { label: "unknown", tone: "neutral" };
  const pendingApproval = approvals.some((approval) => approval.status === "pending");
  if (run.status === "failed" || run.status === "cancelled") return { label: run.status, tone: "danger" };
  if (pendingApproval || run.status === "waiting_for_approval") return { label: "waiting_for_approval", tone: "warning" };
  return { label: run.status, tone: runStatusTone(run.status) };
}

export function runDuration(run: RunSession): string {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = Date.parse(run.endedAt ?? run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function terminalRunEvent(events: readonly RunEventEnvelope[]): RunEventEnvelope | undefined {
  return [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
}
