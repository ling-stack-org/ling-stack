import type { RunEventEnvelope, RunSession } from "../../types.js";
import type { SettingsStatusTone } from "./startup-readiness-view-models.js";

export interface RunDiagnosticsRowViewModel {
  readonly id: string;
  readonly run: RunSession;
  readonly statusLabelKey: string;
  readonly title: string;
  readonly tone: SettingsStatusTone;
  readonly updatedAt: string;
}

export interface RunDiagnosticsCounts {
  readonly attention: number;
  readonly recent: number;
  readonly running: number;
}

export interface RunActivityViewModel {
  readonly id: string;
  readonly labelKey: string;
  readonly timestamp: string;
  readonly tone: SettingsStatusTone;
}

export function projectRunDiagnosticsRows(runs: readonly RunSession[]): readonly RunDiagnosticsRowViewModel[] {
  return runs.slice(0, 12).map((run) => ({
    id: run.id,
    run,
    statusLabelKey: runStatusLabelKey(run.status),
    title: runTitle(run),
    tone: runStatusTone(run.status),
    updatedAt: run.updatedAt,
  }));
}

export function projectRunDiagnosticsCounts(runs: readonly RunSession[]): RunDiagnosticsCounts {
  return {
    recent: runs.length,
    running: runs.filter((run) => run.status === "running" || run.status === "queued").length,
    attention: runs.filter((run) => run.status === "failed" || run.status === "cancelled" || run.status === "waiting_for_approval").length,
  };
}

export function projectRecentRunActivity(events: readonly RunEventEnvelope[]): readonly RunActivityViewModel[] {
  return events
    .filter((event) => event.type !== "assistant_text_delta" && event.type !== "assistant_thinking_delta" && event.type !== "tool_update")
    .slice(-6)
    .reverse()
    .map((event) => ({
      id: event.id,
      labelKey: runEventLabelKey(event.type),
      timestamp: event.ts,
      tone: runEventTone(event.type),
    }));
}

export function runTitle(run: RunSession): string {
  const snapshot = run.taskSnapshot;
  if (snapshot && typeof snapshot === "object" && "title" in snapshot) {
    const title = (snapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "";
}

export function runNextStepLabelKey(run: RunSession): string {
  if (run.status === "failed" || run.status === "cancelled") {
    return "Review the failure summary, then repair the model or rerun from the original workspace.";
  }
  if (run.status === "running") {
    return "This run is still active. Refresh diagnostics to inspect the latest state.";
  }
  if (run.status === "waiting_for_approval") return "This run is waiting for approval.";
  if (run.status === "queued") return "This run is queued.";
  return "This run is complete. Raw evidence is available below when support needs it.";
}

export function runStatusLabelKey(status: RunSession["status"]): string {
  if (status === "waiting_for_approval") return "Waiting for approval";
  if (status === "succeeded") return "Succeeded";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  return "Failed";
}

export function runStatusTone(status: RunSession["status"]): SettingsStatusTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "waiting_for_approval") return "warning";
  if (status === "running") return "info";
  return "neutral";
}

function runEventLabelKey(type: RunEventEnvelope["type"]): string {
  if (type === "run_created") return "Run created";
  if (type === "run_start" || type === "turn_start") return "Run started";
  if (type === "run_end" || type === "turn_end" || type === "result") return "Run completed";
  if (type === "run_error") return "Run failed";
  if (type === "run_cancelled") return "Run cancelled";
  if (type === "approval_requested") return "Approval requested";
  if (type === "approval_approved") return "Approval approved";
  if (type === "approval_denied" || type === "approval_expired" || type === "approval_cancelled") return "Approval needs attention";
  if (type === "artifact_created") return "Artifact created";
  if (type === "tool_start") return "Tool started";
  if (type === "tool_end") return "Tool completed";
  if (type === "run_intervention_failed") return "Intervention failed";
  if (type === "run_intervention_created" || type === "run_followup_queued" || type === "run_interrupt_requested") return "Intervention queued";
  if (type === "run_continuation_starting" || type === "run_continuation_started") return "Run continuation";
  if (type === "workspace_change_recovery_started" || type === "workspace_changes_undone" || type === "workspace_changes_reapplied") return "Workspace recovery activity";
  return "Run activity";
}

function runEventTone(type: RunEventEnvelope["type"]): SettingsStatusTone {
  if (type === "run_error" || type === "run_cancelled" || type === "approval_denied" || type === "run_intervention_failed") return "danger";
  if (type === "approval_requested" || type === "approval_expired" || type === "approval_cancelled") return "warning";
  if (type === "run_end" || type === "result" || type === "artifact_created" || type === "approval_approved") return "success";
  if (type === "run_start" || type === "turn_start" || type === "tool_start" || type === "run_continuation_started") return "info";
  return "neutral";
}
