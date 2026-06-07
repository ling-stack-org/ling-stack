import type { MediaAdapterErrorCode, NormalizedMediaAdapterError } from "./types.js";

export class MediaAdapterExecutionError extends Error {
  readonly code: MediaAdapterErrorCode;

  constructor(code: MediaAdapterErrorCode, message: string) {
    super(message);
    this.name = "MediaAdapterExecutionError";
    this.code = code;
  }
}

export function normalizeMediaAdapterError(error: unknown): NormalizedMediaAdapterError {
  if (error instanceof MediaAdapterExecutionError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      code: "provider_internal_error",
      message: error.message,
    };
  }
  return {
    code: "provider_internal_error",
    message: String(error),
  };
}
