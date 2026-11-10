import { RefreshCw, Workflow } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getWorkUnitHarnessDiagnostics } from "../../api/runtime.js";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow } from "../../shared/components/MetaRow.js";
import { Button, EmptyState, InlineFeedback, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { HarnessDiagnosticObservationV1, HarnessDiagnosticRecordV1, WorkUnitDetailResponse } from "../../types.js";
import { createHarnessDiagnosticsController, type HarnessDiagnosticsAvailability, type HarnessDiagnosticsIssue, type HarnessDiagnosticsState } from "./harness-diagnostics-controller.js";

/** Loaded only while the existing Debug details disclosure is open; a new scope creates an empty controller synchronously. */
export function RunHarnessDiagnostics({ cwd, runId, workUnitId, workUnitDetail, enabled }: {
  readonly cwd: string;
  readonly runId: string;
  readonly workUnitId: string | undefined;
  readonly workUnitDetail: WorkUnitDetailResponse | undefined;
  readonly enabled: boolean;
}): React.JSX.Element {
  const linkedWorkUnitId = workUnitDetail?.workUnit.id;
  const linkedRunId = workUnitDetail?.workUnit.linkedRunId;
  const controller = useMemo(() => createHarnessDiagnosticsController(getWorkUnitHarnessDiagnostics, {
    cwd, runId, workUnitId: workUnitId ?? "", linkedWorkUnitId, linkedRunId,
  }), [cwd, runId, workUnitId, linkedWorkUnitId, linkedRunId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    void controller.activate();
    return () => { controller.suspend(); };
  }, [controller, enabled]);
  return <RunHarnessDiagnosticsView state={state} onRefresh={() => void controller.refresh()} onLoadMore={() => void controller.loadMore()} />;
}

export function RunHarnessDiagnosticsView({ state, onRefresh, onLoadMore }: {
  readonly state: HarnessDiagnosticsState;
  readonly onRefresh: () => void;
  readonly onLoadMore: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const loading = state.phase === "loading";
  const canRefresh = state.phase !== "unavailable";
  return (
    <section className="runs-subsection runs-harness-diagnostics" aria-label={t("Recovery diagnostics")} aria-busy={loading}>
      <div className="runs-harness-heading">
        <h3><Workflow size={15} aria-hidden="true" />{t("Recovery diagnostics")}</h3>
        <Button disabled={!canRefresh || loading} leadingIcon={<RefreshCw size={13} />} onClick={onRefresh} size="sm">{t("Refresh")}</Button>
      </div>
      <p className="runs-readable-copy">{t("Stored recovery metadata only. Lease observations never authorize execution.")}</p>
      {state.observedAt ? <p className="runs-readable-copy">{t("Last read at {time}", { time: formatDateTime(state.observedAt) })}</p> : null}
      {state.phase === "error" ? (
        <InlineFeedback title={t("Recovery diagnostics unavailable")} tone="warning">
          <span>{issueDescription(state.issue, t)}</span>
          <Button onClick={onRefresh} size="sm">{t("Retry")}</Button>
        </InlineFeedback>
      ) : null}
      {state.phase === "unavailable" ? <InlineFeedback tone="warning">{availabilityDescription(state.availability, t)}</InlineFeedback> : null}
      {loading ? <p role="status" aria-live="polite">{t("Loading recovery diagnostics...")}</p> : null}
      {state.phase === "ready" && state.items.length === 0 ? <EmptyState compact title={t("No stored recovery records for this run")} description={t("No continuation, controlled tool execution, evaluation or delegation metadata was found.")} /> : null}
      <div className="runs-section-list runs-harness-record-list">
        {state.items.map(item => <HarnessDiagnosticRow key={`${item.record.kind}:${item.record.id}`} item={item} />)}
      </div>
      {state.items.length ? <p role="status" aria-live="polite">{t("Loaded {count} recovery records", { count: state.items.length })}</p> : null}
      {state.nextCursor && state.phase === "ready" ? <Button onClick={onLoadMore} size="sm">{t("Load more")}</Button> : null}
      {state.phase === "ready" && !state.nextCursor ? <p className="runs-readable-copy">{t("All pages loaded. Refresh for newer recovery records.")}</p> : null}
    </section>
  );
}

function HarnessDiagnosticRow({ item }: { readonly item: HarnessDiagnosticObservationV1 }): React.JSX.Element {
  const { t } = useI18n();
  const record = item.record;
  const fields: readonly (readonly [string, string | number | undefined])[] = [
    ["Record ID", record.id], ["Run", record.runId], ["Work unit", record.workUnitId], ["Revision", record.revision],
    ["Created", formatDateTime(record.createdAt)], ["Updated", formatDateTime(record.updatedAt)],
    ["Claim owner", record.claimOwner], ["Lease expires", record.claimExpiresAt ? formatDateTime(record.claimExpiresAt) : undefined],
    ["Next retry", record.nextAttemptAt ? formatDateTime(record.nextAttemptAt) : undefined], ["Failure code", record.failureCode],
    ...diagnosticRecordFields(record),
  ];
  return (
    <InspectorSection title={diagnosticRecordTitle(record, t)} summary={
      <span className="runs-harness-record-summary">
        <code title={record.id}>{record.id.length > 36 ? `${record.id.slice(0, 16)}…${record.id.slice(-16)}` : record.id}</code>
        <StatusIndicator label={t(record.state)} />
      </span>
    }>
      <div className="runs-summary-grid">
        <MetaRow label={t("Stored lease observation")} value={leaseDescription(item.leaseStatus, t)} compact />
        {fields.filter(([, value]) => value !== undefined).map(([label, value]) => <MetaRow key={label} label={t(label)} value={String(value)} compact />)}
      </div>
      <h4>{t("Attempt observations")}</h4>
      {item.attempts.map(attempt => (
        <div className="runs-summary-grid" key={attempt.id}>
          <MetaRow label={t("Attempt")} value={attempt.id} compact />
          <MetaRow label={t("Observation")} value={t(attempt.status === "observed" ? "Attempt found" : attempt.status === "missing" ? "Attempt missing" : "Attempt ownership mismatch")} compact />
          {attempt.status === "observed" ? <>
            <MetaRow label={t("Work unit")} value={attempt.workUnitId ?? "-"} compact />
            <MetaRow label={t("Runtime owner")} value={attempt.runtimeInstanceId ?? "-"} compact />
            <MetaRow label={t("Observed fence (not execution authority)")} value={attempt.fencingToken ?? "-"} compact />
            <MetaRow label={t("Status")} value={t(attempt.attemptStatus ?? "-")} compact />
          </> : null}
        </div>
      ))}
    </InspectorSection>
  );
}

function diagnosticRecordTitle(record: HarnessDiagnosticRecordV1, t: Translate): string {
  switch (record.kind) {
    case "continuation": return t("Continuation");
    case "tool_execution": return `${t("Controlled tool execution")} · ${record.toolName}`;
    case "evaluation": return t("Run evaluation");
    case "delegation": return t("Delegation");
  }
}

function diagnosticRecordFields(record: HarnessDiagnosticRecordV1): readonly (readonly [string, string | number | undefined])[] {
  switch (record.kind) {
    case "continuation": return [
      ["Source attempt", record.sourceAttemptId], ["Target attempt", record.targetAttemptId], ["Origin", record.origin],
      ["Strategy", record.strategy], ["Runner", record.runnerId], ["Continuation generation", record.generation],
      ["Failure detail artifact", record.failureDetailArtifactId], ["Completed", record.completedAt ? formatDateTime(record.completedAt) : undefined],
    ];
    case "tool_execution": return [
      ["Attempt", record.attemptId], ["Tool call", record.toolCallId], ["Tool", record.toolName], ["Executor kind", record.executorKind],
      ["Continuation", record.continuationId], ["Delegation step", record.delegationStepId], ["Supersedes execution", record.supersedesExecutionId],
      ["Policy snapshot artifact", record.policySnapshotArtifactId], ["Approval", record.approvalId], ["Sandbox profile", record.sandboxProfileId],
      ["Execution started", record.executionStartedAt ? formatDateTime(record.executionStartedAt) : undefined],
      ["Execution finished", record.executionFinishedAt ? formatDateTime(record.executionFinishedAt) : undefined],
    ];
    case "evaluation": return [
      ["Root run", record.rootRunId], ["Completed", record.completedAt ? formatDateTime(record.completedAt) : undefined],
    ];
    case "delegation": return [
      ["Root run", record.rootRunId], ["Parent attempt", record.parentAttemptId], ["Workflow", record.workflowId],
      ["Workflow step", record.workflowStepId], ["Parent delegation step", record.parentDelegationStepId], ["Child run", record.childRunId],
      ["Required", String(record.required)], ["Depth", record.depth], ["Completed", record.completedAt ? formatDateTime(record.completedAt) : undefined],
    ];
  }
}

function issueDescription(issue: HarnessDiagnosticsIssue | undefined, t: Translate): string {
  switch (issue) {
    case "workspace_uninitialized": return t("This workspace has not been initialized. This read does not initialize or recover it.");
    case "not_found": return t("The work unit was not found in this workspace. Refresh the run details before retrying.");
    case "invalid_query": return t("Recovery pagination is invalid. Retry to reload from the first page.");
    case "invalid_response": return t("Recovery data does not match the selected run or page. It was not displayed; retry to reload.");
    default: return t("Recovery diagnostics could not be read. Retry after checking the workspace connection.");
  }
}

function availabilityDescription(status: HarnessDiagnosticsAvailability | undefined, t: Translate): string {
  switch (status) {
    case "run_unlinked": return t("No linked work unit and run are available for recovery diagnostics.");
    case "run_missing": return t("The linked run is missing. Recovery diagnostics are unavailable.");
    case "linkage_unloaded": return t("Work unit linkage is not loaded. Refresh the run details to inspect recovery diagnostics.");
    default: return t("Work unit and run ownership do not match. Recovery diagnostics were not displayed.");
  }
}

function leaseDescription(status: HarnessDiagnosticObservationV1["leaseStatus"], t: Translate): string {
  switch (status) {
    case "unclaimed": return t("No stored claim");
    case "held": return t("Stored lease not expired at observation");
    case "expired": return t("Stored lease expired at observation");
    case "terminal_retained": return t("Terminal record retains historical lease");
  }
}
