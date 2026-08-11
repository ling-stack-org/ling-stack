import { Archive, CalendarClock, MessageCircle, MoreHorizontal, Pause, Play, RotateCcw } from "lucide-react";
import {
  Button,
  DataRow,
  IconButton,
  InlineFeedback,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { AutomationMutationKind } from "../../domains/automations/use-automations-domain.js";
import type { AutomationStatus } from "../../types.js";
import type { AutomationDefinitionViewModel, AutomationTranslate } from "./automation-view-models.js";

export function AutomationDefinitionRow({
  action,
  error,
  selected,
  t,
  viewModel,
  onArchive,
  onOpenRun,
  onOpenSchedule,
  onOpenThread,
  onRun,
  onSelect,
  onStatusChange,
}: {
  readonly action?: AutomationMutationKind;
  readonly error: string;
  readonly selected: boolean;
  readonly t: AutomationTranslate;
  readonly viewModel: AutomationDefinitionViewModel;
  readonly onArchive: (automationId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenSchedule: (automationId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onRun: (automationId: string) => void;
  readonly onSelect: (automationId: string) => void;
  readonly onStatusChange: (automationId: string, status: AutomationStatus) => void;
}): React.JSX.Element {
  const { automation, latestRun } = viewModel;
  const busy = Boolean(action);
  const primaryMutation = action === "run" || action === "status" || action === "target";
  const primaryDisabled = viewModel.primaryAction === "select" || (viewModel.primaryAction === "inspect-failure" && !latestRun?.runId);

  function runPrimaryAction(): void {
    if (viewModel.primaryAction === "inspect-failure" && latestRun?.runId) {
      onOpenRun(latestRun.runId);
      return;
    }
    if (viewModel.primaryAction === "resume") {
      onStatusChange(automation.id, "enabled");
      return;
    }
    if (viewModel.primaryAction === "fix-target" || viewModel.primaryAction === "select") {
      onSelect(automation.id);
      return;
    }
    onRun(automation.id);
  }

  return (
    <DataRow
      aria-label={automation.title}
      className="automation-ui2-definition-row"
      data-automation-id={automation.id}
      identity={(
        <div className="automation-ui2-row-identity">
          <strong>{automation.title}</strong>
          {automation.description ? <span>{automation.description}</span> : null}
          {error ? (
            <InlineFeedback className="automation-ui2-row-error" title={t("Setup needs attention")} tone="danger">
              {error}
            </InlineFeedback>
          ) : null}
        </div>
      )}
      selected={selected}
      status={<StatusIndicator compact label={viewModel.statusLabel} tone={viewModel.statusTone} />}
      summary={(
        <div className="automation-ui2-row-summary">
          <span>{viewModel.targetLabel}</span>
          <span>{viewModel.scheduleLabel}</span>
        </div>
      )}
      actions={(
        <div className="automation-ui2-row-actions" onClick={(event) => event.stopPropagation()}>
          <Button
            disabled={primaryDisabled}
            leadingIcon={viewModel.primaryAction === "resume" ? <RotateCcw size={14} /> : <Play size={14} />}
            loading={primaryMutation}
            loadingLabel={viewModel.primaryActionLabel}
            onClick={runPrimaryAction}
            size="sm"
            variant="secondary"
          >
            {viewModel.primaryActionLabel}
          </Button>
          {automation.status === "enabled" ? (
            <IconButton
              disabled={busy}
              icon={Pause}
              label={t("Pause")}
              onClick={() => onStatusChange(automation.id, "paused")}
            />
          ) : null}
          <IconButton
            disabled={busy}
            icon={CalendarClock}
            label={t("Schedule")}
            onClick={() => onOpenSchedule(automation.id)}
          />
          <IconButton
            icon={MessageCircle}
            label={t("Thread")}
            onClick={() => onOpenThread(automation.threadId)}
          />
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label={t("More")} />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem disabled={busy} onSelect={() => onArchive(automation.id)} tone="danger">
                <Archive aria-hidden="true" size={15} />
                {t("Archive")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      )}
      onClick={() => onSelect(automation.id)}
    />
  );
}
