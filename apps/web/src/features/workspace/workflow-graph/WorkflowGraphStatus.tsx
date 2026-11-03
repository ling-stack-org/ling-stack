import { Ban, CheckCircle2, Circle, CircleHelp, CircleX, Clock3, LoaderCircle, PauseCircle, SkipForward } from "lucide-react";
import type { WorkflowGraphIssue, WorkflowGraphStatus as Status } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";

const labels: Record<Status, string> = {
  pending: "Pending", running: "Working", waiting: "Waiting", blocked: "Blocked", failed: "Failed",
  cancelled: "Cancelled", succeeded: "Succeeded", skipped: "Skipped", unknown: "Unknown",
};
const icons = { pending: Circle, running: LoaderCircle, waiting: Clock3, blocked: PauseCircle,
  failed: CircleX, cancelled: Ban, succeeded: CheckCircle2, skipped: SkipForward, unknown: CircleHelp };

export function WorkflowGraphStatus({ status }: { readonly status: Status }): React.JSX.Element {
  const { t } = useI18n();
  const Icon = icons[status];
  return <span className="workflow-graph-status" data-status={status}><Icon size={14} aria-hidden="true" />{t(workflowGraphStatusLabel(status))}</span>;
}

export function workflowGraphStatusLabel(status: Status): string { return labels[status]; }

export function workflowGraphIssueLabel(issue: WorkflowGraphIssue): string {
  const labels: Record<WorkflowGraphIssue, string> = {
    dependencies_unavailable: "Dependencies unavailable", missing_dependency: "Missing dependency",
    invalid_dependency: "Invalid dependency", duplicate_id: "Duplicate step ID", cycle: "Dependency cycle",
    truncated: "Incomplete dependencies", observation_unavailable: "Stale snapshot",
  };
  return labels[issue];
}
