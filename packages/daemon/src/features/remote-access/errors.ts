import type { RemoteErrorCodeV1 } from "@ling-stack/contracts";

export class RemoteAccessError extends Error {
  constructor(
    readonly code: RemoteErrorCodeV1,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RemoteAccessError";
  }
}
