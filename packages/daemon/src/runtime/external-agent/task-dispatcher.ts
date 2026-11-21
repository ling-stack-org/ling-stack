import type { PiRunnerEvent, PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import type { RegisteredRunner } from "../runners.js";
import { ExternalAgentFederationService } from "./federation.js";

export type ExternalAgentDispatchOutcome = "completed" | "unknown";

export interface ExternalAgentDispatchRequest {
  readonly federation: ExternalAgentFederationService;
  readonly taskId: string;
  readonly runner: RegisteredRunner;
  readonly options: PiRunnerRunOptions;
  /** Admission is checked immediately before the external adapter is called. */
  readonly assertAdmission?: () => void;
}

export interface ExternalAgentDispatchResult {
  readonly taskId: string;
  readonly outcome: ExternalAgentDispatchOutcome;
  readonly result?: PiRunnerResult;
  readonly reason?: string;
}

export type ExternalAgentDispatchBlocker =
  | "task_id_mismatch"
  | "runner_disabled"
  | "runner_not_external"
  | "adapter_missing"
  | "evidence_commit_unverified"
  | "abort_propagation_unverified"
  | "attempt_fencing_unverified"
  | "workspace_boundary_unverified"
  | "artifact_import_unverified"
  | "admission_rejected";

export class ExternalAgentDispatchError extends Error {
  constructor(readonly code: ExternalAgentDispatchBlocker, message: string) {
    super(message);
    this.name = "ExternalAgentDispatchError";
  }
}

/**
 * Runs one already-admitted federation task through the configured external
 * Runner Adapter. Admission remains owned by Work Item and federation code.
 * This helper only owns the adapter boundary and turns an unconfirmed adapter
 * result into an explicit unknown outcome.
 */
export async function dispatchExternalAgentTask(input: ExternalAgentDispatchRequest): Promise<ExternalAgentDispatchResult> {
  assertDispatchReady(input);
  try {
    input.assertAdmission?.();
  } catch (error) {
    throw new ExternalAgentDispatchError("admission_rejected", error instanceof Error ? error.message : String(error));
  }
  input.federation.markRunning(input.taskId);

  const onEvent = input.options.onEvent;
  const options: PiRunnerRunOptions = {
    ...input.options,
    onEvent: (event) => {
      input.federation.appendEvent(input.taskId, summarizeRunnerEvent(event));
      onEvent?.(event);
    },
  };
  try {
    const result = await input.runner.adapter.runTask(options);
    input.federation.markCompleted(input.taskId);
    input.federation.appendEvent(input.taskId, {
      type: "dispatch_completed",
      taskId: input.taskId,
      eventCount: result.events.length,
    });
    return { taskId: input.taskId, outcome: "completed", result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.federation.markUnknown(input.taskId, input.options.signal?.aborted ? "external_dispatch_cancelled_unknown" : reason.slice(0, 500));
    return { taskId: input.taskId, outcome: "unknown", reason };
  }
}

export function assertDispatchReady(input: ExternalAgentDispatchRequest): void {
  if (input.options.signal?.aborted) {
    throw new ExternalAgentDispatchError("admission_rejected", "External Agent dispatch was cancelled before adapter admission.");
  }
  if (input.options.task.id !== input.taskId) {
    throw new ExternalAgentDispatchError("task_id_mismatch", "Runner task identity does not match the federation task receipt.");
  }
  if (input.runner.status !== "enabled") {
    throw new ExternalAgentDispatchError("runner_disabled", `External Runner ${input.runner.id} is not enabled.`);
  }
  if (input.runner.executionBoundary !== "external") {
    throw new ExternalAgentDispatchError("runner_not_external", `Runner ${input.runner.id} is not an external adapter.`);
  }
  if (!input.runner.adapter || typeof input.runner.adapter.runTask !== "function") {
    throw new ExternalAgentDispatchError("adapter_missing", `External Runner ${input.runner.id} has no adapter.`);
  }
  const conformance = input.runner.toolExecutionConformance;
  const blockers: readonly [ExternalAgentDispatchBlocker, string][] = [
    ["evidence_commit_unverified", "external evidence commit is not verified"],
    ["abort_propagation_unverified", "external abort propagation is not verified"],
    ["attempt_fencing_unverified", "external attempt fencing is not verified"],
    ["workspace_boundary_unverified", "external workspace boundary is not verified"],
    ["artifact_import_unverified", "external artifact import is not verified"],
  ];
  const fields: Readonly<Record<ExternalAgentDispatchBlocker, keyof typeof conformance>> = {
    evidence_commit_unverified: "evidenceCommitVerified",
    abort_propagation_unverified: "abortPropagationVerified",
    attempt_fencing_unverified: "attemptFencingVerified",
    workspace_boundary_unverified: "workspaceBoundaryVerified",
    artifact_import_unverified: "artifactImportVerified",
    task_id_mismatch: "evidenceCommitVerified",
    runner_disabled: "evidenceCommitVerified",
    runner_not_external: "evidenceCommitVerified",
    adapter_missing: "evidenceCommitVerified",
    admission_rejected: "evidenceCommitVerified",
  };
  for (const [code, message] of blockers) {
    if (conformance[fields[code]] !== true) throw new ExternalAgentDispatchError(code, `${input.runner.id}: ${message}.`);
  }
}

function summarizeRunnerEvent(event: PiRunnerEvent): Record<string, unknown> {
  const summary: Record<string, unknown> = { type: event.type };
  if ("taskId" in event && typeof event.taskId === "string") summary.taskId = event.taskId;
  if (event.type === "assistant_text_delta") summary.text = event.text.slice(0, 512);
  if (event.type === "run_error") summary.message = event.message.slice(0, 512);
  if (event.type === "tool_start") {
    summary.toolCallId = event.toolCallId;
    summary.toolName = event.toolName;
  }
  return summary;
}
