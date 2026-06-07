import type { MediaAdapter, MediaExecutionRequest, MediaExecutionResult } from "./types.js";
import { normalizeMediaAdapterError } from "./errors.js";

export async function executeMediaJob(adapter: MediaAdapter, request: MediaExecutionRequest): Promise<MediaExecutionResult> {
  if (!adapter.supports(request.operation)) {
    return {
      status: "failed",
      artifacts: [],
      errorCode: "unsupported_capability",
      errorMessage: `${adapter.displayName} does not support ${request.operation}`,
    };
  }

  try {
    const result = await adapter.execute(request);
    if (result.status === "succeeded") {
      return {
        ...result,
        artifacts: result.artifacts,
        errorCode: undefined,
        errorMessage: undefined,
      };
    }
    return {
      status: "failed",
      artifacts: result.artifacts,
      errorCode: result.errorCode ?? "provider_internal_error",
      errorMessage: result.errorMessage ?? "Media adapter execution failed.",
    };
  } catch (error) {
    const normalized = normalizeMediaAdapterError(error);
    return {
      status: "failed",
      artifacts: [],
      errorCode: normalized.code,
      errorMessage: normalized.message,
    };
  }
}
