import { ExternalLink, MessageCircle, Play, Search, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  InlineFeedback,
  InspectorSection,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { AutomationMutationKind } from "../../domains/automations/use-automations-domain.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationTarget,
  Channel,
  LingThread,
} from "../../types.js";
import { automationTargetFromId, automationTargetOptions } from "./automation-form-models.js";
import type {
  AutomationDefinitionViewModel,
  AutomationDraftViewModel,
  AutomationTranslate,
} from "./automation-view-models.js";

export function AutomationExecutionInspector({
  action,
  automationViewModel,
  channels,
  cwd,
  draftViewModel,
  error,
  latestRun,
  preview,
  t,
  threads,
  onOpenRun,
  onOpenThread,
  onPreview,
  onRepairTarget,
  onRun,
}: {
  readonly action?: AutomationMutationKind;
  readonly automationViewModel?: AutomationDefinitionViewModel;
  readonly channels: readonly Channel[];
  readonly cwd: string;
  readonly draftViewModel?: AutomationDraftViewModel;
  readonly error: string;
  readonly latestRun?: AutomationRun;
  readonly preview?: AutomationContextPreview;
  readonly t: AutomationTranslate;
  readonly threads: readonly LingThread[];
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onPreview: (automationId: string) => void;
  readonly onRepairTarget: (automationId: string, target: AutomationTarget) => void;
  readonly onRun: (automationId: string) => void;
}): React.JSX.Element {
  const automation = automationViewModel?.automation;
  const draft = draftViewModel?.draft;
  const [repairTargetId, setRepairTargetId] = useState("workspace");
  const targetOptions = useMemo(() => automationTargetOptions({ channels, threads }), [channels, threads]);
  useEffect(() => setRepairTargetId("workspace"), [automation?.id]);

  if (!automation && !draft) {
    return (
      <aside className="automation-execution-inspector automation-ui2-inspector" aria-label={t("Execution details")} data-automation-inspector>
        <EmptyState compact icon={<Search size={18} />} title={t("No automation selected")} description={t("Select an automation to inspect trigger and output details.")} />
      </aside>
    );
  }

  const statusLabel = automationViewModel?.statusLabel ?? draftViewModel?.statusLabel ?? t("Ready");
  const statusTone = automationViewModel?.statusTone ?? draftViewModel?.statusTone ?? "neutral";
  const targetLabel = automationViewModel?.targetLabel ?? draftViewModel?.targetLabel ?? t("Missing");
  const scheduleLabel = automationViewModel?.scheduleLabel ?? draftViewModel?.scheduleLabel ?? t("Missing");
  const failed = latestRun?.status === "failed" || automationViewModel?.primaryState === "definition-error";
  const needsTargetRepair = Boolean(automationViewModel?.targetUnavailable);
  const busy = Boolean(action);

  return (
    <aside className="automation-execution-inspector automation-ui2-inspector" aria-label={t("Execution details")} data-automation-inspector>
      <div className="automation-ui2-inspector-header">
        <div><h2>{t("Execution details")}</h2><strong>{automation?.title ?? draft?.title ?? t("Untitled draft")}</strong></div>
        <StatusIndicator compact label={statusLabel} tone={statusTone} />
      </div>
      {error ? <InlineFeedback title={t("Setup needs attention")} tone="danger">{error}</InlineFeedback> : null}

      <div className="automation-ui2-inspector-sections">
        <InspectorSection open title={t("Execution details")} summary={scheduleLabel}>
          <dl className="automation-ui2-inspector-grid">
            <div><dt>{t("Target")}</dt><dd>{targetLabel}</dd></div>
            <div><dt>{t("Schedule")}</dt><dd>{scheduleLabel}</dd></div>
            <div><dt>{t("Model")}</dt><dd>{automation?.model ?? draft?.executionPolicy?.providerPresetId ?? "--"}</dd></div>
            <div><dt>{t("Runtime")}</dt><dd>{automation?.executionEnvironment ? t(automation.executionEnvironment === "worktree" ? "Worktree" : "Local") : t("Conversation")}</dd></div>
          </dl>
        </InspectorSection>

        <InspectorSection open={Boolean(latestRun)} title={t("Latest run")} summary={latestRun ? formatDateTime(latestRun.firedAt) : undefined}>
          {latestRun ? (
            <div className="automation-ui2-latest-run">
              <StatusIndicator compact label={t(latestRun.status)} tone={latestRun.status === "failed" ? "danger" : latestRun.status === "succeeded" ? "success" : "info"} />
              <span>{formatDateTime(latestRun.firedAt)}</span>
              {latestRun.runId ? (
                <Button leadingIcon={<ExternalLink size={14} />} onClick={() => onOpenRun(latestRun.runId as string)} size="sm" variant="ghost">
                  {t("Open run")}
                </Button>
              ) : null}
            </div>
          ) : <span>{t("No runs yet")}</span>}
        </InspectorSection>

        {automation && (failed || needsTargetRepair) ? (
          <InspectorSection open title={t("Failure details")} summary={needsTargetRepair ? t("Unavailable") : t("Recent run failed")}>
            <div className="automation-ui2-repair">
              <p>{needsTargetRepair
                ? t("Review the schedule or run the automation manually.")
                : t("Recent run did not start. Check the trigger target, then retry this automation.")}</p>
              {needsTargetRepair ? (
                <div className="automation-ui2-target-repair">
                  <Select aria-label={t("Target")} disabled={busy} value={repairTargetId} onChange={(event) => setRepairTargetId(event.target.value)}>
                    {targetOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
                  </Select>
                  <Button
                    leadingIcon={<Wrench size={14} />}
                    loading={action === "target"}
                    loadingLabel={t("Target")}
                    onClick={() => onRepairTarget(automation.id, automationTargetFromId(repairTargetId, cwd))}
                    size="sm"
                  >
                    {t("Target")}
                  </Button>
                </div>
              ) : (
                <Button leadingIcon={<Play size={14} />} loading={action === "run"} loadingLabel={t("Retry")} onClick={() => onRun(automation.id)} size="sm">
                  {t("Retry")}
                </Button>
              )}
            </div>
          </InspectorSection>
        ) : null}

        <InspectorSection title={t("Context preview")} summary={preview ? `${preview.selectedRefs.length}` : undefined}>
          {preview ? (
            <pre className="automation-ui2-preview">{preview.contextMarkdown || preview.renderedPrompt}</pre>
          ) : automation ? (
            <Button loading={action === "preview"} loadingLabel={t("Context preview")} onClick={() => onPreview(automation.id)} size="sm" variant="ghost">
              {t("Context preview")}
            </Button>
          ) : <span>{t("No output has been recorded yet.")}</span>}
        </InspectorSection>

        <InspectorSection title={t("Output")} summary={latestRun?.outputArtifactIds.length ? String(latestRun.outputArtifactIds.length) : undefined}>
          <div className="automation-ui2-output-actions">
            <span>{latestRun?.outputArtifactIds.length
              ? t("{count} output artifact generated", { count: latestRun.outputArtifactIds.length })
              : t("No output has been recorded yet.")}</span>
            {automation ? (
              <Button leadingIcon={<MessageCircle size={14} />} onClick={() => onOpenThread(automation.threadId)} size="sm" variant="ghost">
                {t("Thread")}
              </Button>
            ) : null}
          </div>
        </InspectorSection>

        <InspectorSection title={t("Technical details")} summary={t("Raw diagnostics")}>
          <pre className="automation-ui2-raw">{technicalDetails(automation, draft, latestRun, preview)}</pre>
        </InspectorSection>
      </div>
    </aside>
  );
}

function technicalDetails(
  automation: AutomationDefinition | undefined,
  draft: AutomationDraft | undefined,
  run: AutomationRun | undefined,
  preview: AutomationContextPreview | undefined,
): string {
  return JSON.stringify({
    automationId: automation?.id,
    draftId: draft?.id,
    error: run?.errorMessage ?? automation?.lastErrorMessage,
    outputArtifactIds: run?.outputArtifactIds,
    renderedPrompt: preview?.renderedPrompt,
    rrule: automation?.rrule,
    runId: run?.runId,
    target: automation?.target ?? draft?.target,
    threadId: automation?.threadId ?? run?.threadId,
  }, null, 2);
}
