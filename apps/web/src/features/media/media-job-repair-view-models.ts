import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import type { MediaJob, ProviderPreset } from "../../types.js";
import type {
  MediaJobApprovalView,
  MediaJobDisplayContext,
  MediaJobRepairView,
  MediaJobResultView,
  MediaJobSourceView,
} from "./media-job-types.js";
import { redactSensitiveText } from "./media-job-result-view-models.js";

export function deriveMediaJobSourceView(
  job: MediaJob,
  providers: readonly ProviderPreset[],
  context?: MediaJobDisplayContext,
): MediaJobSourceView {
  const executionSource = job.executionSource;
  if (executionSource?.kind === "workflow" || (!executionSource && job.workflowVersionId)) {
    return context?.source ?? {
      kind: "workflow_missing",
      versionId: executionSource?.kind === "workflow" ? executionSource.workflowVersionId : job.workflowVersionId ?? "",
      reason: "version_missing",
    };
  }
  const providerId = executionSource?.kind === "provider" ? executionSource.providerPresetId : job.providerPresetId ?? "";
  const provider = providers.find((item) => item.id === providerId);
  return provider
    ? { kind: "provider", id: provider.id, name: provider.displayName, runtime: resolveMediaProviderRuntimeState(provider, job.operation) }
    : { kind: "provider_missing", id: providerId };
}

export function deriveMediaJobRepairView(input: {
  readonly job: MediaJob;
  readonly source: MediaJobSourceView;
  readonly approval: MediaJobApprovalView;
  readonly result: MediaJobResultView;
}): MediaJobRepairView | undefined {
  const { job, source, approval, result } = input;
  const rawDetails = redactSensitiveText(job.errorMessage?.trim() || "No raw generation error was returned.");
  if (result.state === "ready" && job.status === "succeeded") return undefined;
  if (approval.kind === "pending") return repair("warning", "Waiting for review", "Approve or reject this generation request in the review queue.", "open_approval", "Open review queue", rawDetails);
  if (approval.kind === "missing") return repair("warning", "Review request is unavailable", "Check generation task and approval status before trying again.", "refresh", "Check status", rawDetails);
  if (source.kind === "provider_missing") return repair("danger", "Model route is unavailable", "Configure a generation model before retrying this task.", "repair_provider", "Configure generation model", rawDetails);
  if (source.kind === "provider" && !source.runtime.canRun) return providerRepair(source.runtime.reason, rawDetails);
  if (source.kind === "workflow_missing") return repair("danger", "Workflow is unavailable", "Open the workflow library to choose or restore a workflow.", "repair_workflow", "Open workflow", rawDetails);
  if (source.kind === "workflow" && source.status !== "ready") return repair("danger", "Workflow is not ready", "Open this workflow and resolve its validation state.", "repair_workflow", "Open workflow", rawDetails);
  if (source.kind === "workflow" && (source.connection.kind === "missing" || source.connection.status !== "ready")) {
    return repair("danger", "Workflow connection needs attention", "Open connection settings and restore this workflow connection.", "repair_connection", "Open connection settings", rawDetails);
  }
  if (result.state === "missing" || result.state === "unavailable") return repair("danger", "No usable result was returned", "The task finished without an available image or video.", "retry", "Retry generation", rawDetails);
  return rawFailureRepair(rawDetails);
}

function providerRepair(reason: string | undefined, rawDetails: string): MediaJobRepairView {
  if (reason === "provider_disabled") return repair("danger", "This model route is disabled", "Enable this route before generating again.", "repair_provider", "Edit this model", rawDetails);
  if (reason === "operation_unsupported") return repair("danger", "This model does not support this task type", "Choose or edit a model that supports this operation.", "repair_provider", "Choose or edit a model", rawDetails);
  if (reason === "base_url_missing") return repair("danger", "This model route needs a Base URL", "Add a Base URL to this model route before retrying.", "repair_provider", "Edit this model", rawDetails);
  if (reason === "secret_missing") return repair("danger", "This model needs an API key", "Add an API key to this model route before retrying.", "repair_provider", "Add API key", rawDetails);
  if (reason === "live_transport_invalid" || reason === "live_transport_required") return repair("danger", "Real generation is not connected", "Update this model route's generation transport.", "repair_provider", "Edit this model", rawDetails);
  if (reason === "unsupported_live_adapter") return repair("danger", "This model cannot run this generation type", "Choose a supported generation model.", "repair_provider", "Choose another model", rawDetails);
  return repair("danger", "Model route is unavailable", "Choose or configure a runnable generation model.", "repair_provider", "Configure generation model", rawDetails);
}

function rawFailureRepair(rawDetails: string): MediaJobRepairView {
  const lower = rawDetails.toLowerCase();
  if (/429|rate limit|rate limited|quota/u.test(lower)) return repair("warning", "The provider limited this request", "Try again later or choose another generation route.", "retry", "Retry generation", rawDetails);
  if (/timeout|timed out|network|econn|fetch failed/u.test(lower)) return repair("danger", "The provider did not respond in time", "Check the connection, then retry generation.", "retry", "Retry generation", rawDetails);
  if (/invalid_request|bad_request|rejected|\b400\b/u.test(lower)) return repair("danger", "The generation request was rejected", "Check the source and task settings before retrying.", "retry", "Retry generation", rawDetails);
  return repair("danger", "Generation failed", "Review the technical details, then retry generation.", "retry", "Retry generation", rawDetails);
}

function repair(
  tone: MediaJobRepairView["tone"],
  titleKey: string,
  descriptionKey: string,
  id: MediaJobRepairView["primaryAction"]["id"],
  labelKey: string,
  rawDetails: string,
): MediaJobRepairView {
  return { tone, titleKey, descriptionKey, primaryAction: { id, labelKey, disabled: false, emphasis: "primary" }, rawDetails };
}
