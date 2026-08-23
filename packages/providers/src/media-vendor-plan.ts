import type { MediaExecutionRequest, MediaVendorAdapterDefinition, MediaVendorRequestPlan } from "./types.js";
import { redactSecrets } from "./redaction.js";

export function createMediaVendorRequestPlan(
  definition: MediaVendorAdapterDefinition,
  request: MediaExecutionRequest,
): MediaVendorRequestPlan {
  return {
    mode: "static_vendor_request_plan",
    liveCall: false,
    vendor: definition.kind,
    operation: request.operation,
    provider: {
      presetId: request.provider.id,
      kind: request.provider.kind,
      providerId: request.provider.providerId,
      model: request.provider.model,
      baseUrl: request.provider.baseUrl,
      apiKeyRef: request.provider.apiKeyRef,
    },
    payload: {
      prompt: request.prompt,
      input: redactSecrets(request.input),
      ...(request.videoImageInputs?.length ? { videoImageInputs: request.videoImageInputs } : {}),
    },
    notes: [
      `${definition.displayName} is resolved through the media adapter registry.`,
      "This is a local request plan only. No live vendor HTTP request was made.",
    ],
  };
}
