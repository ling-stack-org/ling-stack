import type { RunEventEnvelope } from "../types.js";
import {
  formatUnknownPreview,
  readDataBoolean,
  readDataField,
  readDataString,
} from "./data.js";

export type RunActivityStatus = "running" | "succeeded" | "failed" | "waiting" | "neutral";

export interface RunActivityItem {
  readonly id: string;
  readonly seq: number;
  readonly ts: string;
  readonly kind: "run" | "thinking" | "tool" | "artifact" | "approval";
  readonly status: RunActivityStatus;
  readonly titleKey: string;
  readonly values?: Readonly<Record<string, string | number>>;
  readonly detail?: string;
}

export function buildRunActivities(events: readonly RunEventEnvelope[]): readonly RunActivityItem[] {
  const activities: RunActivityItem[] = [];
  const toolStarts = new Map<string, RunEventEnvelope>();
  const toolEnds = new Map<string, RunEventEnvelope>();

  for (const event of events) {
    if (event.type === "tool_start") {
      const toolCallId = readToolCallId(event);
      if (toolCallId) {
        toolStarts.set(toolCallId, event);
      }
    }
    if (event.type === "tool_end") {
      const toolCallId = readToolCallId(event);
      if (toolCallId) {
        toolEnds.set(toolCallId, event);
      }
    }
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.type === "assistant_thinking_delta") {
      const first = event;
      while (events[index + 1]?.type === "assistant_thinking_delta") {
        index += 1;
      }
      const last = events[index] ?? first;
      activities.push({
        id: `${first.id}-thinking-group`,
        seq: first.seq,
        ts: last.ts,
        kind: "thinking",
        status: "running",
        titleKey: "AI is analyzing the task",
        detail: `#${first.seq}${last.seq !== first.seq ? `-#${last.seq}` : ""}`,
      });
      continue;
    }

    if (event.type === "tool_start") {
      const toolCallId = readToolCallId(event);
      const endEvent = toolCallId ? toolEnds.get(toolCallId) : undefined;
      activities.push(buildToolActivity(event, endEvent));
      continue;
    }

    if (event.type === "tool_end" && !toolStarts.has(readToolCallId(event))) {
      activities.push(buildToolActivity(event, event));
      continue;
    }

    if (event.type === "artifact_created") {
      activities.push({
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        kind: "artifact",
        status: "succeeded",
        titleKey: "Generated artifact: {title}",
        values: { title: readArtifactTitle(event.data) },
        detail: readArtifactDetail(event.data),
      });
      continue;
    }

    if (event.type === "approval_requested") {
      activities.push(buildApprovalActivity(event, "waiting", "Approval requested: {action}"));
      continue;
    }
    if (event.type === "approval_approved") {
      activities.push(buildApprovalActivity(event, "succeeded", "Approval approved: {action}"));
      continue;
    }
    if (event.type === "approval_denied") {
      activities.push(buildApprovalActivity(event, "failed", "Approval denied: {action}"));
      continue;
    }
    if (event.type === "approval_expired") {
      activities.push(buildApprovalActivity(event, "failed", "Approval expired: {action}"));
      continue;
    }

    if (event.type === "run_created" || event.type === "run_start") {
      activities.push({
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        kind: "run",
        status: "running",
        titleKey: "Run started",
        detail: readRunDetail(event.data),
      });
      continue;
    }
    if (event.type === "run_end") {
      activities.push({
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        kind: "run",
        status: "succeeded",
        titleKey: "Run completed",
        detail: readRunDetail(event.data),
      });
      continue;
    }
    if (event.type === "run_error" || event.type === "run_cancelled") {
      activities.push({
        id: event.id,
        seq: event.seq,
        ts: event.ts,
        kind: "run",
        status: "failed",
        titleKey: event.type === "run_error" ? "Run failed" : "Run cancelled",
        detail: readDataString(event.data, "message") || formatUnknownPreview(event.data, 160),
      });
    }
  }

  return activities;
}

function buildToolActivity(startEvent: RunEventEnvelope, endEvent: RunEventEnvelope | undefined): RunActivityItem {
  const toolName = readDataString(startEvent.data, "toolName") || readDataString(endEvent?.data, "toolName") || "tool";
  const target = readToolTarget(startEvent.data) || readToolTarget(endEvent?.data) || toolName;
  const failed = endEvent ? readDataBoolean(endEvent.data, "isError") : false;
  const titleKey = failed
    ? "Tool failed: {tool}"
    : endEvent
      ? toolTitleKey(toolName)
      : "Using {tool}";
  let values: Readonly<Record<string, string | number>> | undefined;
  if (titleKey.includes("{target}")) {
    values = { target };
  } else if (titleKey.includes("{tool}")) {
    values = { tool: toolName };
  }

  return {
    id: `${startEvent.id}-activity`,
    seq: startEvent.seq,
    ts: endEvent?.ts ?? startEvent.ts,
    kind: "tool",
    status: failed ? "failed" : endEvent ? "succeeded" : "running",
    titleKey,
    values,
    detail: readToolDetail(startEvent.data, endEvent?.data),
  };
}

function toolTitleKey(toolName: string): string {
  if (toolName === "read") {
    return "Read {target}";
  }
  if (toolName === "grep") {
    return "Search {target}";
  }
  if (toolName === "ls") {
    return "List {target}";
  }
  if (toolName === "find") {
    return "Find {target}";
  }
  return "Tool completed: {tool}";
}

function buildApprovalActivity(event: RunEventEnvelope, status: RunActivityStatus, titleKey: string): RunActivityItem {
  const action = readDataString(event.data, "actionType") || "approval";
  return {
    id: event.id,
    seq: event.seq,
    ts: event.ts,
    kind: "approval",
    status,
    titleKey,
    values: { action },
    detail: readDataString(event.data, "title") || readDataString(event.data, "approvalId"),
  };
}

function readToolCallId(event: RunEventEnvelope | undefined): string {
  return event ? readDataString(event.data, "toolCallId") : "";
}

function readToolTarget(data: unknown): string {
  const args = readDataField(data, "args");
  const path = readDataString(args, "path");
  const pattern = readDataString(args, "pattern");
  const command = readDataString(args, "command") || readDataString(args, "cmd") || readDataString(args, "script");
  if (pattern && path) {
    return `${pattern} in ${path}`;
  }
  return path || command || pattern;
}

function readToolDetail(startData: unknown, endData: unknown): string {
  const target = readToolTarget(startData);
  const result = readDataField(endData, "result");
  const error = readDataString(result, "error") || readDataString(endData, "error") || readDataString(endData, "message");
  if (error) {
    return target ? `${target}: ${error}` : error;
  }
  const preview = formatUnknownPreview(result, 160);
  return [target, preview].filter(Boolean).join(" -> ");
}

function readArtifactTitle(data: unknown): string {
  const artifact = readDataField(data, "artifact");
  return readDataString(artifact, "title") || readDataString(artifact, "path") || "artifact";
}

function readArtifactDetail(data: unknown): string {
  const artifact = readDataField(data, "artifact");
  const type = readDataString(artifact, "type");
  const path = readDataString(artifact, "path");
  return [type, path].filter(Boolean).join(" · ");
}

function readRunDetail(data: unknown): string {
  const provider = readDataString(data, "provider");
  const model = readDataString(data, "model");
  const taskId = readDataString(data, "taskId");
  return [provider && model ? `${provider}/${model}` : "", taskId].filter(Boolean).join(" · ");
}
