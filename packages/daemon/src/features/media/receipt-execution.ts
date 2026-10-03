import { normalizeProviderBaseUrlForAdapter, toRuntimeAttemptFence, type MediaJob,
  type MediaWorkflowConnection, type MediaWorkflowOutputRule, type ProviderPreset, type RunStore } from "@ling-stack/core";
import type { MediaExecutionResult } from "@ling-stack/providers";
import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle } from "../../runtime/media-local-executions.js";
import type { MediaRuntimeHandle } from "./executor.js";
import { getHostMediaOperation } from "./host-operation.js";
import type { HostMediaReceiptProducer } from "./host-receipt-producer.js";
import { collectMediaJobArtifacts, MediaArtifactCollectionError, type MediaArtifactCollectionResult } from "./artifact-collector.js";

export function prepareProviderMediaReceipt(input: { readonly store: RunStore; readonly job: MediaJob;
  readonly localExecution: MediaLocalExecutionHandle; readonly supervised: MediaRuntimeHandle;
  readonly provider: ProviderPreset; readonly adapterId: string;
  readonly secretValues?: readonly (string | undefined)[] }): HostMediaReceiptProducer | undefined {
  const host = getHostMediaOperation(input.localExecution);
  if (!host) return undefined;
  try {
    return host.prepareReceipt({ ...input, childFence: toRuntimeAttemptFence(input.supervised.attempt),
      protocol: input.job.operation === "video_generate" ? "seedance_task_v1" : "image_response_v1",
      baseUrl: normalizeProviderBaseUrlForAdapter(input.provider) });
  } catch (error) { throw admissionError(error); }
}

export function prepareWorkflowMediaReceipt(input: { readonly store: RunStore; readonly job: MediaJob;
  readonly localExecution: MediaLocalExecutionHandle; readonly supervised: MediaRuntimeHandle;
  readonly connection: MediaWorkflowConnection; readonly outputRules: readonly MediaWorkflowOutputRule[];
  readonly secretValues?: readonly (string | undefined)[] }): HostMediaReceiptProducer | undefined {
  const host = getHostMediaOperation(input.localExecution);
  if (!host) return undefined;
  const variant = input.connection.health?.protocolVariant ?? input.connection.protocolVariant;
  // A checked/configured exact protocol is captured before discovery, upload or
  // submit. Unknown auto negotiation must not enter GET then late-prepare Core.
  if (variant !== "jobs_v1" && variant !== "prompt_legacy") {
    throw new MediaLocalExecutionAdmissionError("media_protocol_unprepared", "Check the workflow connection before captured execution.");
  }
  try {
    return host.prepareReceipt({ ...input, childFence: toRuntimeAttemptFence(input.supervised.attempt),
      adapterId: "comfyui", protocol: variant === "jobs_v1" ? "comfy_jobs_v1" : "comfy_prompt_legacy_v1",
      baseUrl: input.connection.baseUrl });
  } catch (error) { throw admissionError(error); }
}

/** Confirmed partial rows survive SDK and collection failures; uncertainty is never an empty manifest. */
export function collectMediaExecutionArtifacts(input: { readonly store: RunStore; readonly job: MediaJob;
  readonly execution: MediaExecutionResult; readonly completedAt: string;
  readonly secretValues: readonly (string | undefined)[]; readonly receipt?: HostMediaReceiptProducer }):
    MediaArtifactCollectionResult & { readonly error?: MediaArtifactCollectionError } {
  try {
    return collectMediaJobArtifacts(input.store, input.job, input.execution.artifacts, input.completedAt,
      input.secretValues, input.receipt?.collectionContext());
  } catch (error) {
    if (!(error instanceof MediaArtifactCollectionError)) throw error;
    return { artifacts: error.artifacts, manifestItems: error.manifestItems, error };
  }
}

function admissionError(error: unknown): MediaLocalExecutionAdmissionError {
  return error instanceof MediaLocalExecutionAdmissionError ? error
    : new MediaLocalExecutionAdmissionError("media_receipt_preparation_unconfirmed", error instanceof Error ? error.message : String(error));
}
