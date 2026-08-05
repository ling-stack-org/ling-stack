import { join } from "node:path";
import { redactSecrets } from "@ling-stack/core";
import type { PiRunnerEvent, PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { bridgeExternalToolApproval } from "./approval-bridge.js";
import { importExternalAgentArtifact, type ExternalArtifactImportInput } from "./artifact-importer.js";
import { normalizeExternalAgentEvent, type ExternalAgentEvent } from "./event-normalizer.js";
import { assertExternalToolAllowed, defaultExternalToolSurfacePolicy, type ExternalToolProposal } from "./tool-surface.js";
import { resolveExternalWorkspacePath } from "./workspace-boundary.js";

export interface ExternalAgentRunArtifact {
  readonly toolCallId: string;
  readonly role: ExternalArtifactImportInput["role"];
  readonly filename: string;
  readonly content: string;
}

export type ExternalAgentRunOutputEvent =
  | ExternalAgentEvent
  | { readonly type: "tool_proposal"; readonly data: ExternalToolProposal }
  | { readonly type: "artifact"; readonly data: ExternalAgentRunArtifact };

export interface ExternalAgentRunInput {
  readonly runnerId: string;
  readonly cwd: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly prompt: string;
  };
  readonly provider: {
    readonly provider: string;
    readonly model: string;
    readonly api?: string;
  };
  readonly tools: readonly string[];
}

export interface ExternalAgentRunResult {
  readonly taskId?: string;
  readonly events?: readonly ExternalAgentRunOutputEvent[];
  readonly messages?: readonly unknown[];
}

export interface RunExternalAgentTaskOptions {
  readonly runnerId: string;
  readonly backend: string;
  readonly options: PiRunnerRunOptions;
  readonly run: (input: ExternalAgentRunInput, signal?: AbortSignal) => Promise<ExternalAgentRunResult>;
  readonly extraSecrets?: readonly (string | undefined)[];
}

export async function runExternalAgentTask(input: RunExternalAgentTaskOptions): Promise<PiRunnerResult> {
  const { options } = input;
  if (options.signal?.aborted) {
    throw new Error(`${input.runnerId} run aborted before start.`);
  }

  resolveExternalWorkspacePath({ cwd: options.cwd }, ".");

  const emitted: PiRunnerEvent[] = [];
  const emit = (event: PiRunnerEvent): void => {
    emitted.push(event);
    options.onEvent?.(event);
  };

  emit({
    type: "run_start",
    taskId: options.task.id,
    cwd: options.cwd,
    provider: options.provider.provider,
    model: options.provider.model,
  });
  emit({ type: "turn_start" });

  try {
    const result = await input.run({
      runnerId: input.runnerId,
      cwd: options.cwd,
      task: {
        id: options.task.id,
        title: options.task.title,
        prompt: options.task.prompt,
      },
      provider: {
        provider: options.provider.provider,
        model: options.provider.model,
        api: options.provider.api,
      },
      tools: options.tools ?? [],
    }, options.signal);

    const messages = result.messages ?? [];
    for (const event of result.events ?? []) {
      if (options.signal?.aborted) {
        throw new Error(`${input.runnerId} run cancelled.`);
      }
      await handleExternalAgentEvent(event, input, emit);
    }

    emit({ type: "turn_end" });
    const finalText = extractAssistantText(messages);
    const redactedFinalText = finalText ? String(redactSecrets(finalText, input.extraSecrets ?? [])) : undefined;
    emit({
      type: "message_end",
      role: "assistant",
      ...(redactedFinalText ? { text: redactedFinalText } : {}),
      ...(redactedFinalText ? { contentKinds: ["text"] } : {}),
    });
    emit({ type: "run_end", taskId: options.task.id, messageCount: messages.length });

    return {
      taskId: result.taskId ?? options.task.id,
      events: emitted,
      messages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "run_error", taskId: options.task.id, message });
    throw error;
  }
}

export function coerceExternalAgentRunResult(value: unknown): ExternalAgentRunResult {
  if (!isRecord(value)) {
    throw new Error("External runner result is malformed.");
  }
  return {
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
    events: readExternalAgentEvents(value.events),
    messages: Array.isArray(value.messages) ? value.messages : undefined,
  };
}

async function handleExternalAgentEvent(
  event: ExternalAgentRunOutputEvent,
  input: RunExternalAgentTaskOptions,
  emit: (event: PiRunnerEvent) => void,
): Promise<void> {
  if (event.type === "tool_proposal") {
    await handleToolProposal((event as { readonly type: "tool_proposal"; readonly data: ExternalToolProposal }).data, input, emit);
    return;
  }
  if (event.type === "artifact") {
    handleArtifact((event as { readonly type: "artifact"; readonly data: ExternalAgentRunArtifact }).data, input, emit);
    return;
  }
  const normalized = normalizeExternalAgentEvent(event, input.extraSecrets ?? []);
  if (normalized) {
    emit(normalized);
  }
}

async function handleToolProposal(
  proposal: ExternalToolProposal,
  input: RunExternalAgentTaskOptions,
  emit: (event: PiRunnerEvent) => void,
): Promise<void> {
  assertExternalToolAllowed(proposal, defaultExternalToolSurfacePolicy());
  emit({
    type: "tool_start",
    toolCallId: proposal.backendToolCallId,
    toolName: proposal.toolName,
    args: proposal.input,
  });
  const decision = await bridgeExternalToolApproval(proposal, {
    approvalBridgeVerified: true,
    onApprovalRequired: input.options.onApprovalRequired
      ? async (request) => {
        const decision = await input.options.onApprovalRequired?.({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: request.input,
          task: input.options.task,
          cwd: input.options.cwd,
          defaultApproval: request.defaultApproval,
        });
        return decision ?? { approved: false };
      }
      : undefined,
  });
  emit({
    type: "tool_end",
    toolCallId: proposal.backendToolCallId,
    toolName: proposal.toolName,
    result: { approved: decision.approved, approvalId: decision.approvalId },
    isError: !decision.approved,
  });
}

function handleArtifact(
  artifact: ExternalAgentRunArtifact,
  input: RunExternalAgentTaskOptions,
  emit: (event: PiRunnerEvent) => void,
): void {
  const summary = importExternalAgentArtifact({
    artifactRoot: input.options.runtimePaths?.artifactsDir ?? join(input.options.cwd, ".ling-stack", "artifacts"),
    runId: input.options.task.id,
    toolCallId: artifact.toolCallId,
    role: artifact.role,
    filename: artifact.filename,
    content: artifact.content,
    extraSecrets: input.extraSecrets,
  });
  emit({
    type: "tool_end",
    toolCallId: artifact.toolCallId,
    toolName: "artifact_import",
    result: summary,
    isError: false,
  });
}

function readExternalAgentEvents(value: unknown): readonly ExternalAgentRunOutputEvent[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("External runner events are malformed.");
  }
  return value.map(readExternalAgentEvent);
}

function readExternalAgentEvent(value: unknown): ExternalAgentRunOutputEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("External runner event is malformed.");
  }
  if (value.type === "tool_proposal") {
    return { type: "tool_proposal", data: readExternalToolProposal(value.data) };
  }
  if (value.type === "artifact") {
    return { type: "artifact", data: readExternalRunArtifact(value.data) };
  }
  return {
    type: value.type,
    data: value.data,
  };
}

function readExternalToolProposal(value: unknown): ExternalToolProposal {
  if (
    !isRecord(value) ||
    typeof value.backendToolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !isExternalToolSideEffect(value.sideEffect)
  ) {
    throw new Error("External tool proposal is malformed.");
  }
  return {
    backendToolCallId: value.backendToolCallId,
    toolName: value.toolName,
    input: value.input,
    sideEffect: value.sideEffect,
  };
}

function readExternalRunArtifact(value: unknown): ExternalAgentRunArtifact {
  if (
    !isRecord(value) ||
    typeof value.toolCallId !== "string" ||
    !isExternalArtifactRole(value.role) ||
    typeof value.filename !== "string" ||
    typeof value.content !== "string"
  ) {
    throw new Error("External artifact event is malformed.");
  }
  return {
    toolCallId: value.toolCallId,
    role: value.role,
    filename: value.filename,
    content: value.content,
  };
}

function isExternalToolSideEffect(value: unknown): value is ExternalToolProposal["sideEffect"] {
  return value === "none" ||
    value === "workspace_read" ||
    value === "workspace_write" ||
    value === "shell" ||
    value === "network" ||
    value === "provider_or_secret" ||
    value === "external_delivery";
}

function isExternalArtifactRole(value: unknown): value is ExternalAgentRunArtifact["role"] {
  return value === "result" || value === "stdout" || value === "stderr" || value === "artifact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
