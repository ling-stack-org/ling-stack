import type { ServerResponse } from "node:http";
import {
  type ApprovalRequest,
  type MediaJob,
  type MediaStoreFacet,
  type ProviderStoreFacet,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { resolveProviderSecret } from "../providers/secrets.js";
import { resumePendingProviderMediaJobs, runProviderMediaJobExecution } from "./provider-executor.js";
import { resumePendingWorkflowMediaJobs, runWorkflowMediaJobExecution } from "./workflows/workflow-executor.js";

type MediaRuntimeStartStore =
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet &
  RunExecutionStoreFacet;
type MediaRuntimeTerminalStore = RuntimeSupervisorStoreFacet;
type MediaApprovalDecisionStore = MediaStoreFacet & ProviderStoreFacet;

export interface MediaRuntimeStartRequest {
  readonly store: MediaRuntimeStartStore;
  readonly kind: "media_job";
  readonly ownerType: "media_job";
  readonly ownerId: string;
  readonly providerPresetId?: string;
  readonly linkedMediaJobId: string;
  readonly idempotencyKey: string;
  readonly request: {
    readonly mediaJobId: string;
    readonly providerPresetId?: string;
    readonly workflowVersionId?: string;
    readonly operation: string;
  };
}

export interface MediaRuntimeHandle {
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
}

export interface MediaRuntimeTerminalTransitionRequest {
  readonly store: MediaRuntimeTerminalStore;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly event: "runner_succeeded" | "runner_failed";
  readonly attemptStatus: "succeeded" | "failed";
  readonly runtimeEventType: "work_unit_succeeded" | "work_unit_failed";
  readonly actor: "provider" | "system";
  readonly now: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RunMediaJobHooks {
  readonly startRuntimeWorkUnit: (input: MediaRuntimeStartRequest) => MediaRuntimeHandle;
  readonly transitionRuntimeWorkUnitTerminal: (input: MediaRuntimeTerminalTransitionRequest) => void;
}

export interface MediaJobExecutionResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export interface RunMediaJobExecutionInput {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
}

export async function handleRunMediaJob(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  mediaJobId: string,
  hooks: RunMediaJobHooks,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const result = await runMediaJobExecution({
    cwd,
    storeRegistry,
    secretResolver,
    mediaJobId,
    hooks,
  });
  writeJson(response, result.statusCode, result.body);
}

export async function runMediaJobExecution(input: RunMediaJobExecutionInput): Promise<MediaJobExecutionResult> {
  const store = input.storeRegistry.getStore(input.cwd);
  const job = store.getMediaJob(input.mediaJobId);
  if (!job) {
    return { statusCode: 404, body: { error: "media_job_not_found", message: `生成任务不存在：${input.mediaJobId}` } };
  }
  return job.executionSource.kind === "workflow"
    ? await runWorkflowMediaJobExecution(input)
    : await runProviderMediaJobExecution(input);
}

export function dispatchMediaJobExecution(input: RunMediaJobExecutionInput): void {
  void runMediaJobExecution(input).catch((error) => {
    const store = input.storeRegistry.getStore(input.cwd);
    const job = store.getMediaJob(input.mediaJobId);
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    const provider = job.providerPresetId ? store.getProviderPreset(job.providerPresetId) : undefined;
    const mediaSecret = provider?.apiKeyRef ? resolveProviderSecret(store, provider, input.secretResolver) : undefined;
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
    store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString());
  });
}

export function resumePendingMediaJobExecutions(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly hooks: RunMediaJobHooks;
}): void {
  resumePendingWorkflowMediaJobs(input);
  resumePendingProviderMediaJobs(input);
}

export function syncMediaJobForApprovalDecision(input: {
  readonly cwd: string;
  readonly store: MediaApprovalDecisionStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly approval: ApprovalRequest;
  readonly hooks: RunMediaJobHooks;
  readonly now: string;
}): MediaJob | undefined {
  const { approval } = input;
  if (approval.actionType !== "media_cost" || !approval.mediaJobId) {
    return undefined;
  }

  const job = input.store.getMediaJob(approval.mediaJobId);
  if (!job) {
    return undefined;
  }

  if (approval.status === "approved") {
    const currentJob = job.status === "waiting_for_approval"
      ? input.store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, input.now) ?? job
      : job;
    dispatchMediaJobExecution({
      cwd: input.cwd,
      storeRegistry: input.storeRegistry,
      secretResolver: input.secretResolver,
      mediaJobId: job.id,
      hooks: input.hooks,
    });
    return input.store.getMediaJob(job.id) ?? currentJob;
  }

  if ((approval.status === "denied" || approval.status === "expired") && job.status === "waiting_for_approval") {
    return failMediaJobForApprovalDecision(input.store, job, approval);
  }

  return job;
}

function failMediaJobForApprovalDecision(store: MediaStoreFacet, job: MediaJob, approval: ApprovalRequest): MediaJob {
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "failed",
      errorMessage: approval.status === "denied"
        ? "媒体生成费用确认未通过，任务没有执行。"
        : "媒体生成费用确认已失效，任务没有执行。",
    },
    new Date().toISOString(),
  ) ?? job;
}
