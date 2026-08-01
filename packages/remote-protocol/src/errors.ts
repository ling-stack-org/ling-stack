export type RemoteProtocolValidationCode =
  | "invalid_json"
  | "invalid_frame"
  | "invalid_field"
  | "invalid_time"
  | "unknown_frame_type"
  | "protocol_incompatible"
  | "payload_too_large"
  | "command_expired"
  | "sequence_invalid";

/** A local parse error. Callers must not expose its field path in auth close reasons. */
export class RemoteProtocolError extends Error {
  readonly code: RemoteProtocolValidationCode;
  readonly path?: string;

  constructor(code: RemoteProtocolValidationCode, message: string, path?: string) {
    super(message);
    this.name = "RemoteProtocolError";
    this.code = code;
    this.path = path;
  }
}

export function isRemoteProtocolError(value: unknown): value is RemoteProtocolError {
  return value instanceof RemoteProtocolError;
}
