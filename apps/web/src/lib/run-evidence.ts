import type { RunEventEnvelope, RunSession } from "../types.js";
import {
  formatEventPreview,
  formatUnknownPreview,
  readDataBoolean,
  readDataString,
  readFirstDataScalarString,
  readFirstDataString,
} from "./data.js";

export type RunRepairTarget = "providers" | "approvals" | "run";

export interface RunRepairHint {
  readonly target: RunRepairTarget;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
}

export interface RuntimeFailureSummary {
  readonly eventLabel: string;
  readonly toolName: string;
  readonly issueText: string;
  readonly command: string;
  readonly cwd: string;
  readonly targetPath: string;
  readonly exitCode: string;
  readonly suggestion: string;
}

export function displayLinkedRunStatus(
  runId: string,
  linkedRun: RunSession | undefined,
  activeRunId: string,
  latestStatus: string,
): string {
  if (runId === activeRunId && latestStatus !== "idle") {
    return latestStatus;
  }
  return linkedRun?.status ?? "saved";
}

export function buildRunRepairHint(
  run: RunSession | undefined,
  pendingApprovalCount: number,
  status: string,
  extraMessage = "",
): RunRepairHint | undefined {
  const effectiveStatus = status || run?.status || "";
  if (pendingApprovalCount > 0 || effectiveStatus === "waiting_for_approval" || run?.status === "waiting_for_approval") {
    return {
      target: "approvals",
      title: "Approval required",
      detail: pendingApprovalCount > 0
        ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? "" : "s"} pending before this run can continue.`
        : "This run is waiting for an approval decision.",
      actionLabel: "Approvals",
    };
  }

  if (effectiveStatus !== "failed" && run?.status !== "failed") {
    return undefined;
  }

  const message = [run?.errorMessage, extraMessage].filter(Boolean).join(" ");
  if (isProviderRepairMessage(message)) {
    return {
      target: "providers",
      title: "Provider repair needed",
      detail: "The failure looks related to provider auth, preflight, endpoint, or model configuration.",
      actionLabel: "Model Workbench",
    };
  }

  return {
    target: "run",
    title: "Inspect run failure",
    detail: "The failure looks like a runtime or tool issue. Inspect events, fix the workspace or task, then rerun.",
    actionLabel: "Open run",
  };
}

export function isProviderRepairMessage(message: string): boolean {
  return /provider|preflight|api[-_ ]?key|apikey|auth|secret|credential|model|base[-_ ]?url|endpoint|token/i.test(message);
}

export function buildRuntimeFailureSummary(
  run: RunSession,
  events: readonly RunEventEnvelope[],
  workspaceCwd: string,
): RuntimeFailureSummary {
  const failureEvent = findRuntimeFailureEvent(events);
  const relatedToolStart = findRelatedToolStart(events, failureEvent);
  const dataSources = [failureEvent?.data, relatedToolStart?.data, run.requestSnapshot].filter((item): item is unknown => item !== undefined);
  const toolName = readFirstDataString(dataSources, ["toolName", "tool", "name", "actionType"])
    || (failureEvent?.type.startsWith("tool_") ? failureEvent.type.replace("tool_", "") : "runtime");
  const issueText = (failureEvent ? readRunEventIssueText(failureEvent) : "") || run.errorMessage || "No failure message was recorded for this run.";
  const command = readFirstDataString(dataSources, ["command", "cmd", "script", "input"]);
  const cwd = readFirstDataString(dataSources, ["cwd", "workdir", "workingDirectory"]) || run.cwd || workspaceCwd;
  const targetPath = readFirstDataString(dataSources, ["path", "filePath", "targetPath", "target"]);
  const exitCode = readFirstDataScalarString(dataSources, ["exitCode", "exit_code", "statusCode"]);

  return {
    eventLabel: failureEvent ? `#${failureEvent.seq} ${failureEvent.type}` : "run status",
    toolName,
    issueText,
    command,
    cwd,
    targetPath,
    exitCode,
    suggestion: buildRuntimeRepairSuggestion(toolName, command, targetPath),
  };
}

export function findRuntimeFailureEvent(events: readonly RunEventEnvelope[]): RunEventEnvelope | undefined {
  const reversed = [...events].reverse();
  return reversed.find((event) => event.type === "tool_end" && readDataBoolean(event.data, "isError"))
    ?? reversed.find((event) => event.type === "run_error")
    ?? reversed.find((event) => ["run_cancelled", "run_end"].includes(event.type));
}

export function findRelatedToolStart(
  events: readonly RunEventEnvelope[],
  failureEvent: RunEventEnvelope | undefined,
): RunEventEnvelope | undefined {
  if (!failureEvent || !failureEvent.type.startsWith("tool_")) {
    return undefined;
  }

  const failureIndex = events.findIndex((event) => event.id === failureEvent.id);
  const candidates = [...(failureIndex >= 0 ? events.slice(0, failureIndex) : events)].reverse();
  const toolCallId = readDataString(failureEvent.data, "toolCallId");
  const toolName = readDataString(failureEvent.data, "toolName");

  return candidates.find((event) => {
    if (event.type !== "tool_start") {
      return false;
    }
    if (toolCallId) {
      return readDataString(event.data, "toolCallId") === toolCallId;
    }
    if (toolName) {
      return readDataString(event.data, "toolName") === toolName;
    }
    return true;
  });
}

export function buildRuntimeRepairSuggestion(toolName: string, command: string, targetPath: string): string {
  const normalizedTool = toolName.toLowerCase();
  if (normalizedTool.includes("bash") || command) {
    return "Check the command, cwd, dependency state, or task prompt. Edit the task if the instruction is wrong, then rerun.";
  }
  if (["edit", "write"].some((tool) => normalizedTool.includes(tool)) || targetPath) {
    return "Check the target path and intended file change. Edit the task or workspace files, then rerun.";
  }
  return "Inspect the failed event, fix the task or workspace state, then rerun from the same persisted snapshot.";
}

export function readRunEventIssueText(event: RunEventEnvelope | undefined): string {
  if (!event) {
    return "";
  }
  return readDataString(event.data, "message")
    || readDataString(event.data, "error")
    || readDataString(event.data, "detail")
    || readDataString(event.data, "reason");
}

export function readRunEvidenceMessage(run: RunSession, terminalEvent: RunEventEnvelope | undefined): string {
  const runError = run.errorMessage?.trim();
  if (runError) {
    return runError;
  }

  const terminalIssue = readRunEventIssueText(terminalEvent).trim();
  if (terminalIssue) {
    return terminalIssue;
  }

  const terminalPreview = terminalEvent ? formatEventPreview(terminalEvent.data) : "";
  if (terminalPreview) {
    return terminalPreview;
  }

  if (run.status === "succeeded") {
    return "Run completed without a result payload.";
  }
  if (run.status === "failed") {
    return "Run failed without a captured error message.";
  }
  if (run.status === "cancelled") {
    return "Run was cancelled.";
  }
  if (run.status === "waiting_for_approval") {
    return "Run is waiting for approval.";
  }
  if (run.status === "running") {
    return "Run is still running.";
  }
  return "Run is queued.";
}

export function buildAssistantOutputPreview(assistantText: string): string {
  return formatUnknownPreview(assistantText, 260) || "No assistant output captured.";
}

export function summarizeToolEvents(toolEvents: readonly RunEventEnvelope[]): { readonly total: number; readonly errorCount: number } {
  let errorCount = 0;
  for (const event of toolEvents) {
    if (readDataBoolean(event.data, "isError") || Boolean(readDataString(event.data, "error"))) {
      errorCount += 1;
    }
  }
  return {
    total: toolEvents.length,
    errorCount,
  };
}

export function inferRunStatus(events: readonly RunEventEnvelope[], isRunning: boolean): string {
  const terminal = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled"].includes(event.type));
  if (terminal?.type === "run_error") {
    return "failed";
  }
  if (terminal?.type === "run_cancelled") {
    return "cancelled";
  }
  if (terminal?.type === "result") {
    return "succeeded";
  }
  return isRunning ? "running" : "idle";
}

export function readRunProviderPresetId(run: RunSession): string {
  return run.providerPresetId ?? readDataString(run.requestSnapshot, "providerPresetId");
}

export function readRunWorkspaceCwd(run: RunSession, fallbackCwd: string): string {
  return readDataString(run.requestSnapshot, "workspaceCwd") || fallbackCwd || run.cwd;
}

export function readTaskTitle(taskSnapshot: unknown): string {
  if (typeof taskSnapshot === "object" && taskSnapshot !== null && "title" in taskSnapshot) {
    const value = (taskSnapshot as { title?: unknown }).title;
    return typeof value === "string" ? value : "";
  }
  return "";
}

export function readTaskPrompt(taskSnapshot: unknown): string {
  if (typeof taskSnapshot === "object" && taskSnapshot !== null && "prompt" in taskSnapshot) {
    const value = (taskSnapshot as { prompt?: unknown }).prompt;
    return typeof value === "string" ? value : "";
  }
  return "";
}
