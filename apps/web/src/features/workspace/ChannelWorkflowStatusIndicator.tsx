import { displayLinkedRunStatus } from "../../lib/run-evidence.js";
import { useI18n } from "../../i18n.js";
import { StatusIndicator } from "../../shared/ui/index.js";
import type { ChannelWorkflow, ChannelWorkflowStep, RunSession } from "../../types.js";
import {
  channelLinkedWorkflowStatusPresentation,
  channelWorkflowRunStatusPresentation,
  channelWorkflowStatusPresentation,
  channelWorkflowStepStatusPresentation,
} from "./channel-workflow-status-presentation.js";

type ChannelWorkflowStatusIndicatorProps =
  | { readonly kind: "workflow"; readonly status: ChannelWorkflow["status"] }
  | { readonly kind: "step"; readonly status: ChannelWorkflowStep["status"] }
  | { readonly kind: "linked-workflow"; readonly status: ChannelWorkflow["status"] | undefined }
  | { readonly kind: "run"; readonly status: string | undefined };

function resolvePresentation(props: ChannelWorkflowStatusIndicatorProps) {
  if (props.kind === "workflow") return channelWorkflowStatusPresentation(props.status);
  if (props.kind === "step") return channelWorkflowStepStatusPresentation(props.status);
  if (props.kind === "linked-workflow") return channelLinkedWorkflowStatusPresentation(props.status);
  return channelWorkflowRunStatusPresentation(props.status);
}

export function ChannelWorkflowStatusIndicator(props: ChannelWorkflowStatusIndicatorProps): React.JSX.Element {
  const { t } = useI18n();
  const presentation = resolvePresentation(props);
  const label = t(presentation.labelKey);
  return (
    <StatusIndicator
      compact
      className="channel-workflow-status"
      data-status-id={presentation.id}
      data-status-kind={props.kind}
      label={label}
      title={label}
      tone={presentation.tone}
    />
  );
}

export function ChannelWorkflowStatusLabel({ status }: { readonly status: ChannelWorkflow["status"] }): React.JSX.Element {
  const { t } = useI18n();
  return <>{t(channelWorkflowStatusPresentation(status).labelKey)}</>;
}

export function ChannelWorkflowLinkedStatusIndicators({
  linkedRunId,
  linkedWorkflowId,
  linkedRun,
  linkedWorkflow,
  activeRunId,
  latestStatus,
}: {
  readonly linkedRunId: string | undefined;
  readonly linkedWorkflowId: string | undefined;
  readonly linkedRun: RunSession | undefined;
  readonly linkedWorkflow: ChannelWorkflow | undefined;
  readonly activeRunId: string;
  readonly latestStatus: string;
}): React.JSX.Element | null {
  if (!linkedRunId && !linkedWorkflowId) return null;
  const linkedRunStatus = linkedRunId
    ? displayLinkedRunStatus(linkedRunId, linkedRun, activeRunId, latestStatus)
    : undefined;
  return (
    <div className="channel-workflow-linked-statuses">
      {linkedWorkflowId ? <ChannelWorkflowStatusIndicator kind="linked-workflow" status={linkedWorkflow?.status} /> : null}
      {linkedRunId ? <ChannelWorkflowStatusIndicator kind="run" status={linkedRunStatus} /> : null}
    </div>
  );
}
