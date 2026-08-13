import type {
  MediaAdapter,
  MediaAdapterErrorCode,
  MediaAdapterFactory,
  MediaExecutionRequest,
  MediaExecutionResult,
  MediaOperation,
  MediaVendorAdapterDefinition,
  MediaVendorRequestPlan,
  MediaVendorTransport,
  MediaVendorTransportMode,
  StaticMediaAdapterOptions,
  StaticVendorMediaAdapterFactoryOptions,
} from "./types.js";
import { MediaAdapterExecutionError } from "./errors.js";
import { createMediaVendorRequestPlan } from "./media-vendor-plan.js";
import { createDisabledMediaVendorTransport } from "./media-vendor-transport.js";
import { getMediaVendorAdapterDefinition } from "./media-vendor-definitions.js";
import { redactSecrets } from "./redaction.js";

export function createStaticMediaAdapter(options: StaticMediaAdapterOptions = {}): MediaAdapter {
  const capabilities: readonly MediaOperation[] = ["image_generate", "image_edit", "video_generate"];
  return {
    id: options.id ?? "static-media",
    displayName: options.displayName ?? "Static Media Adapter",
    capabilities,

    supports(operation: MediaOperation): boolean {
      return capabilities.includes(operation);
    },

    async execute(request: MediaExecutionRequest): Promise<MediaExecutionResult> {
      if (request.input.forceFailure === true) {
        return {
          status: "failed",
          artifacts: [],
          errorCode: "provider_internal_error",
          errorMessage: "Static media adapter forced failure from input.forceFailure.",
        };
      }

      const forcedErrorCode = readForcedErrorCode(request.input);
      if (forcedErrorCode) {
        throw new MediaAdapterExecutionError(forcedErrorCode, `Static media adapter forced ${forcedErrorCode}.`);
      }

      return {
        status: "succeeded",
        artifacts: [
          {
            type: "markdown",
            title: `${formatMediaOperationLabel(request.operation)} static result`,
            contentType: "text/markdown; charset=utf-8",
            pathHint: "static-result.md",
            content: renderStaticMediaResult(request),
          },
        ],
      };
    },
  };
}

export function createStaticVendorMediaAdapterFactory(
  kind: string,
  displayName: string,
  options: StaticVendorMediaAdapterFactoryOptions = {},
): MediaAdapterFactory {
  const definition = getMediaVendorAdapterDefinition(kind) ?? {
    kind,
    displayName,
    capabilities: ["image_generate", "image_edit", "video_generate"],
  };
  return {
    id: `${kind}-static-factory`,
    providerKinds: [kind],
    create(): MediaAdapter {
      return createStaticVendorMediaAdapter({
        id: `${kind}-static`,
        displayName: `${displayName} Static Adapter`,
        definition: {
          ...definition,
          displayName,
        },
        transport: options.transport,
      });
    },
  };
}

function readForcedErrorCode(input: Record<string, unknown>): MediaAdapterErrorCode | undefined {
  const value = input.forceErrorCode;
  if (typeof value !== "string") {
    return undefined;
  }
  return mediaAdapterErrorCodes.includes(value as MediaAdapterErrorCode) ? value as MediaAdapterErrorCode : "provider_internal_error";
}

function renderStaticMediaResult(request: MediaExecutionRequest): string {
  const redactedInput = JSON.stringify(redactSecrets(request.input), null, 2);
  return [
    "# Media job static result",
    "",
    `- Job: ${request.jobId}`,
    `- Operation: ${request.operation}`,
    `- Provider: ${request.provider.displayName} (${request.provider.providerId}/${request.provider.model})`,
    `- Generated at: ${request.requestedAt}`,
    "",
    "## Prompt",
    "",
    request.prompt,
    "",
    "## Input",
    "",
    "```json",
    redactedInput,
    "```",
    "",
    "This artifact was produced by the local static media adapter. No vendor media API was called.",
    "",
  ].join("\n");
}

function createStaticVendorMediaAdapter(options: StaticMediaAdapterOptions & {
  readonly definition: MediaVendorAdapterDefinition;
  readonly transport?: MediaVendorTransport;
}): MediaAdapter {
  const capabilities = options.definition.capabilities;
  const transport = options.transport ?? createDisabledMediaVendorTransport();
  const lifecycleEnabled = options.definition.kind === "seedance";
  const createTransportRequest = (request: MediaExecutionRequest) => ({
    vendor: options.definition,
    requestPlan: createMediaVendorRequestPlan(options.definition, request),
    jobId: request.jobId,
    requestedAt: request.requestedAt,
  });
  return {
    id: options.id ?? `${options.definition.kind}-static`,
    displayName: options.displayName ?? `${options.definition.displayName} Static Adapter`,
    capabilities,

    supports(operation: MediaOperation): boolean {
      return capabilities.includes(operation);
    },

    async execute(request: MediaExecutionRequest): Promise<MediaExecutionResult> {
      if (!capabilities.includes(request.operation)) {
        throw new MediaAdapterExecutionError(
          "unsupported_capability",
          `${options.definition.displayName} static adapter does not support ${request.operation}.`,
        );
      }

      if (request.input.forceFailure === true) {
        return {
          status: "failed",
          artifacts: [],
          errorCode: "provider_internal_error",
          errorMessage: "Static media adapter forced failure from input.forceFailure.",
        };
      }

      const forcedErrorCode = readForcedErrorCode(request.input);
      if (forcedErrorCode) {
        throw new MediaAdapterExecutionError(forcedErrorCode, `Static media adapter forced ${forcedErrorCode}.`);
      }

      const transportRequest = createTransportRequest(request);
      const requestPlan = transportRequest.requestPlan;
      const transportResult = await transport.execute(transportRequest);
      if (transportResult.status === "failed") {
        return {
          status: "failed",
          artifacts: [],
          errorCode: transportResult.errorCode ?? "provider_internal_error",
          errorMessage: transportResult.errorMessage ?? "Media vendor transport failed.",
        };
      }

      return {
        status: "succeeded",
        artifacts: [
          {
            type: "markdown",
            title: `${options.definition.displayName} ${formatMediaOperationLabel(request.operation)} request plan`,
            contentType: "text/markdown; charset=utf-8",
            pathHint: "vendor-request-plan.md",
            content: renderStaticVendorMediaResult(options.definition, request, requestPlan, transport.mode),
          },
          ...(transportResult.artifacts ?? []),
        ],
      };
    },

    ...(lifecycleEnabled && transport.submit ? {
      submit: async (request: MediaExecutionRequest) => await transport.submit!(createTransportRequest(request)),
    } : {}),
    ...(lifecycleEnabled && transport.poll ? {
      poll: async (handle: import("./types.js").MediaExecutionHandle) => await transport.poll!(handle),
    } : {}),
    ...(lifecycleEnabled && transport.collectArtifacts ? {
      collectArtifacts: async (handle: import("./types.js").MediaExecutionHandle) => await transport.collectArtifacts!(handle),
    } : {}),
    ...(lifecycleEnabled && transport.cancel ? {
      cancel: async (handle: import("./types.js").MediaExecutionHandle) => await transport.cancel!(handle),
    } : {}),
  };
}

function renderStaticVendorMediaResult(
  definition: MediaVendorAdapterDefinition,
  request: MediaExecutionRequest,
  plan: MediaVendorRequestPlan,
  transportMode: MediaVendorTransportMode,
): string {
  const requestPlan = JSON.stringify(plan, null, 2);
  return [
    "# Media job static result",
    "",
    `- Job: ${request.jobId}`,
    `- Operation: ${request.operation}`,
    `- Vendor: ${definition.displayName} (${definition.kind})`,
    `- Provider: ${request.provider.displayName} (${request.provider.providerId}/${request.provider.model})`,
    `- Transport: ${transportMode}`,
    `- Generated at: ${request.requestedAt}`,
    "",
    "## Prompt",
    "",
    request.prompt,
    "",
    "## Vendor request plan",
    "",
    "```json",
    requestPlan,
    "```",
    "",
    "This artifact was produced by the local static media adapter. No vendor media API was called.",
    "",
  ].join("\n");
}

function formatMediaOperationLabel(operation: MediaOperation): string {
  if (operation === "image_generate") {
    return "Image generate";
  }
  if (operation === "image_edit") {
    return "Image edit";
  }
  return "Video generate";
}

const mediaAdapterErrorCodes: readonly MediaAdapterErrorCode[] = [
  "auth_failed",
  "model_not_found",
  "rate_limited",
  "quota_exceeded",
  "content_policy_blocked",
  "media_result_unavailable",
  "network_error",
  "timeout",
  "unsupported_capability",
  "provider_internal_error",
  "invalid_request",
];
