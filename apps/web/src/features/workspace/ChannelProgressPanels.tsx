import type { ReactNode } from "react";
import {
  Archive,
  ChevronDown,
  ChevronUp,
  Database,
  FileCheck2,
  FileText,
  Link2,
  MessageSquare,
  SquareTerminal,
  UserPlus,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import {
  buildConversationContextSourceSummaryFromChannelSummary,
  conversationContextSourceSummaryLabel,
  type ConversationContextSourceGroup,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import type {
  ChannelContextSummary,
  ChannelWorkflowStep,
  RunSession,
  Task,
} from "../../types.js";
import {
  ChannelEnvironmentDiffStat,
  type ChannelEnvironmentSummary,
} from "./ChannelEnvironmentPage.js";

export type AttentionProgressTone = "success" | "running" | "waiting" | "blocked" | "failed" | "neutral";

export interface AttentionProgressRow {
  readonly id: string;
  readonly icon: ReactNode;
  readonly tone: AttentionProgressTone;
  readonly primary: string;
  readonly secondary?: string;
  readonly onOpen?: () => void;
}

export function runIsActiveProgressPopoverRun(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

export function taskIsActiveProgressPopoverTask(task: Task): boolean {
  return task.status === "claimed" || task.status === "running" || task.status === "blocked";
}

export function buildActiveProgressSourceSummary({
  contextSummaries,
  workflowSteps,
  selectedTask,
  runningWorkflowStepId,
  t,
}: {
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly selectedTask?: Task;
  readonly runningWorkflowStepId: string;
  readonly t: Translate;
}): ConversationContextSourceSummary | undefined {
  const activeStep = [
    workflowSteps.find((step) => step.id === runningWorkflowStepId),
    ...workflowSteps
      .filter((step) => workflowStepHasActiveContext(step))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ].find((step): step is ChannelWorkflowStep => Boolean(step?.contextSummaryId));
  const activeSummary = activeStep?.contextSummaryId
    ? contextSummaries.find((summary) => summary.id === activeStep.contextSummaryId)
    : undefined;
  if (activeSummary) {
    return buildConversationContextSourceSummaryFromChannelSummary(activeSummary, t);
  }

  if (selectedTask && taskIsActiveProgressPopoverTask(selectedTask)) {
    const taskSummary = contextSummaries
      .filter((summary) => summary.targetType === "task" && summary.targetId === selectedTask.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return taskSummary ? buildConversationContextSourceSummaryFromChannelSummary(taskSummary, t) : undefined;
  }

  return undefined;
}

function workflowStepHasActiveContext(step: ChannelWorkflowStep): boolean {
  return Boolean(step.contextSummaryId) && (
    step.status === "claimed" ||
    step.status === "running" ||
    step.status === "waiting_for_approval" ||
    step.status === "blocked"
  );
}

export function conversationContextSourceGroupIcon(type: string): ReactNode {
  if (type === "message" || type === "channel_message" || type === "private_message") {
    return <MessageSquare size={18} />;
  }
  if (type === "decision" || type === "channel_decision") {
    return <FileCheck2 size={18} />;
  }
  if (type === "file" || type === "workspace_file" || type === "attachment") {
    return <FileText size={18} />;
  }
  if (type === "artifact" || type === "run_artifact") {
    return <Archive size={18} />;
  }
  if (type === "memory" || type === "project_memory") {
    return <Database size={18} />;
  }
  if (type === "web" || type === "url" || type === "page") {
    return <Link2 size={18} />;
  }
  if (type === "teammate" || type === "agent") {
    return <UserPlus size={18} />;
  }
  if (type === "run" || type === "run_session" || type === "task" || type === "channel_task") {
    return <SquareTerminal size={18} />;
  }
  return <FileText size={18} />;
}

export function ProgressPopover({
  expanded,
  onExpandedChange,
  progressRows,
  environmentSummary,
  sourceSummary,
  onOpenSourceGroup,
}: {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly progressRows: readonly AttentionProgressRow[];
  readonly environmentSummary?: ChannelEnvironmentSummary;
  readonly sourceSummary?: ConversationContextSourceSummary;
  readonly onOpenSourceGroup?: (group: ConversationContextSourceGroup, summary: ConversationContextSourceSummary) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const environmentRows = environmentSummary?.popoverRows ?? [];
  if (progressRows.length === 0 && environmentRows.length === 0 && (!sourceSummary || sourceSummary.sourceCount === 0)) {
    return null;
  }
  const sourceGroups = sourceSummary?.groups ?? [];
  return (
    <section className="attention-queue compact" aria-label={t("Summary")}>
      {environmentRows.length > 0 ? (
        <ChannelEnvironmentPopoverSection summary={environmentSummary!} />
      ) : null}
      {sourceSummary && sourceSummary.sourceCount > 0 ? (
        <div className="attention-context-section" aria-label={t("Context source summary")}>
          <div className="attention-section-head">
            <strong>{t("Sources used")}</strong>
            <small>{conversationContextSourceSummaryLabel(sourceSummary, t)}</small>
          </div>
          <div className="attention-context-list">
            {sourceGroups.slice(0, 4).map((group) => (
              <button
                key={group.id}
                className="attention-context-row interactive"
                type="button"
                onClick={() => onOpenSourceGroup?.(group, sourceSummary)}
                aria-label={t("Open {label} sources", { label: group.label })}
              >
                <span className="attention-row-icon neutral">{conversationContextSourceGroupIcon(group.type)}</span>
                <span className="attention-context-copy">
                  <strong>{group.label}</strong>
                  <small>
                    {group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}
                    {group.examples.length > 0 ? ` · ${group.examples.join(", ")}` : ""}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {sourceSummary.droppedCount > 0 || sourceSummary.compactionCount > 0 ? (
            <div className="attention-context-foot">
              {sourceSummary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: sourceSummary.droppedCount })}</span> : null}
              {sourceSummary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: sourceSummary.compactionCount })}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {progressRows.length > 0 ? (
        <div className="attention-progress-preview">
          <div className="attention-section-head attention-progress-head">
            <strong>{t("Summary")}</strong>
            <button
              className="icon-button attention-progress-toggle"
              type="button"
              aria-expanded={expanded}
              onClick={() => onExpandedChange(!expanded)}
              aria-label={expanded ? t("Collapse") : t("Expand")}
              title={expanded ? t("Collapse") : t("Expand")}
            >
              {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
          </div>
          {expanded ? (
            <div className="attention-progress-list" aria-label={t("Progress rows")}>
              {progressRows.slice(0, 6).map((row) => {
                const content = (
                  <>
                    <span className={`attention-row-icon ${row.tone}`}>{row.icon}</span>
                    <span className="attention-progress-copy">
                      <strong>{row.primary}</strong>
                      {row.secondary ? <small>{row.secondary}</small> : null}
                    </span>
                  </>
                );
                return row.onOpen ? (
                  <button key={row.id} className={`attention-progress-row ${row.tone} interactive`} type="button" onClick={row.onOpen}>
                    {content}
                  </button>
                ) : (
                  <div key={row.id} className={`attention-progress-row ${row.tone}`}>
                    {content}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ChannelEnvironmentPopoverSection({
  summary,
}: {
  readonly summary: ChannelEnvironmentSummary;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="attention-environment-section" aria-label={t("Environment")}>
      <div className="attention-section-head">
        <strong>{t("Environment")}</strong>
        <small>{summary.changes?.label ?? summary.review?.label ?? summary.workspace?.modeLabel}</small>
      </div>
      <div className="attention-environment-list">
        {summary.popoverRows.map((row) => {
          const content = (
            <>
              <span className={`attention-row-icon ${row.tone}`}>{row.icon}</span>
              <span className="attention-environment-copy">
                <strong>{row.label}</strong>
                {row.stats ? (
                  <ChannelEnvironmentDiffStat additions={row.stats.additions} deletions={row.stats.deletions} />
                ) : row.value ? (
                  <small title={row.value}>{row.value}</small>
                ) : null}
              </span>
            </>
          );
          return row.onOpen ? (
            <button
              key={row.id}
              className={`attention-environment-row ${row.tone} interactive`}
              type="button"
              onClick={row.onOpen}
              aria-label={row.disabledReason ? `${row.label}. ${row.disabledReason}` : row.label}
              title={row.disabledReason ?? row.value}
            >
              {content}
            </button>
          ) : (
            <div key={row.id} className={`attention-environment-row ${row.tone}`} title={row.disabledReason ?? row.value}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}
