import { decodeUtf8Strict, encodeUtf8 } from "../canonical.js";
import { RemoteProtocolError } from "../errors.js";
import { assertNoDuplicateJsonMembers } from "./json-members.js";

/** Parse bounded strict UTF-8 JSON after rejecting duplicate object member names. */
export function parseJsonInput(input: string | Uint8Array, maxBytes: number): unknown {
  let text: string;
  if (typeof input === "string") {
    if (input.length > maxBytes) {
      throw new RemoteProtocolError("payload_too_large", "JSON input exceeds the byte limit");
    }
    const bytes = encodeUtf8(input);
    if (bytes.length > maxBytes) {
      throw new RemoteProtocolError("payload_too_large", "JSON input exceeds the byte limit");
    }
    text = input;
  } else {
    if (input.length > maxBytes) {
      throw new RemoteProtocolError("payload_too_large", "JSON input exceeds the byte limit");
    }
    text = decodeUtf8Strict(input);
  }
  assertNoDuplicateJsonMembers(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemoteProtocolError("invalid_json", "Input is not valid JSON");
  }
}
