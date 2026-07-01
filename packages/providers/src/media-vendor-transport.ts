import type {
  LiveMediaVendorTransportOptions,
  MediaVendorTransport,
  MediaVendorTransportGateResolution,
  MediaVendorTransportRequest,
  MediaVendorTransportResult,
} from "./types.js";
import { isRecord } from "./utils.js";
import { executeOpenAIImageGeneration } from "./vendors/openai-images.js";
import { executeSeedanceVideoTask } from "./vendors/seedance.js";
import { executeSeedreamImageEdit, executeSeedreamImageGeneration } from "./vendors/seedream.js";

export function createDisabledMediaVendorTransport(): MediaVendorTransport {
  return {
    mode: "disabled",
    async execute(): Promise<MediaVendorTransportResult> {
      return {
        status: "succeeded",
        artifacts: [],
      };
    },
  };
}

export function createLiveMediaVendorTransport(options: LiveMediaVendorTransportOptions): MediaVendorTransport {
  return {
    mode: "live",
    async execute(request: MediaVendorTransportRequest): Promise<MediaVendorTransportResult> {
      if (!options.baseUrl) {
        return {
          status: "failed",
          errorCode: "invalid_request",
          errorMessage: `${request.vendor.displayName} live media transport requires provider baseUrl.`,
        };
      }
      if (!options.apiKeyRef) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport requires provider apiKeyRef.`,
        };
      }
      if (!options.apiKeyConfigured) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport secret is not configured: ${options.apiKeyRef}.`,
        };
      }
      if (!options.apiKey) {
        return {
          status: "failed",
          errorCode: "auth_failed",
          errorMessage: `${request.vendor.displayName} live media transport secret value is not available for ${options.apiKeyRef}.`,
        };
      }
      if (request.vendor.kind === "seedance" && request.requestPlan.operation === "video_generate") {
        return await executeSeedanceVideoTask(request, options);
      }
      if (
        (request.vendor.kind === "openai" || request.vendor.kind === "openai-compatible") &&
        request.requestPlan.operation === "image_generate"
      ) {
        return await executeOpenAIImageGeneration(request, options);
      }
      if (request.vendor.kind !== "seedream") {
        return {
          status: "failed",
          errorCode: "unsupported_capability",
          errorMessage: `Live media vendor transport does not support ${request.vendor.kind} ${request.requestPlan.operation}.`,
        };
      }
      if (request.requestPlan.operation === "image_edit") {
        return await executeSeedreamImageEdit(request, options);
      }
      if (request.requestPlan.operation !== "image_generate") {
        return {
          status: "failed",
          errorCode: "unsupported_capability",
          errorMessage: "Seedream live media transport currently supports image_generate and URL-based image_edit only.",
        };
      }
      return await executeSeedreamImageGeneration(request, options);
    },
  };
}

export function resolveMediaVendorTransportGateConfig(compat: unknown): MediaVendorTransportGateResolution {
  const disabled: MediaVendorTransportGateResolution = {
    ok: true,
    config: { mode: "disabled" },
  };
  if (!isRecord(compat)) {
    return disabled;
  }

  const mediaVendorTransport = compat.mediaVendorTransport;
  if (mediaVendorTransport === undefined) {
    return disabled;
  }
  if (!isRecord(mediaVendorTransport)) {
    return {
      ok: false,
      errorCode: "invalid_request",
      errorMessage: "compat.mediaVendorTransport must be an object with mode disabled or live.",
    };
  }

  const mode = mediaVendorTransport.mode;
  if (mode === undefined || mode === "disabled") {
    return disabled;
  }
  if (mode === "live") {
    return {
      ok: true,
      config: { mode },
    };
  }
  if (mode === "fake") {
    return {
      ok: false,
      errorCode: "invalid_request",
      errorMessage: "compat.mediaVendorTransport.mode=fake is reserved for test injection and cannot be enabled from provider presets.",
    };
  }
  return {
    ok: false,
    errorCode: "invalid_request",
    errorMessage: "compat.mediaVendorTransport.mode must be disabled or live.",
  };
}
