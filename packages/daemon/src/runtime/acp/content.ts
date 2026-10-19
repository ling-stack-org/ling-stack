import { nativeMcpContent } from "../adapters/native-tool-content.js";
import { NativeOutputError } from "../adapters/native-stream-redaction.js";
import { record } from "./live-errors.js";

/** ACP permits null optional presentation fields; extensions never become visible content. */
export function nativeAcpContent(value: unknown): ReturnType<typeof nativeMcpContent>[number] {
  if (!record(value)) invalid();
  let content: Record<string, unknown>;
  switch (value.type) {
    case "text": content = { type: "text", text: value.text }; break;
    case "image": case "audio":
      content = { type: value.type, data: value.data, mimeType: value.mimeType }; break;
    case "resource_link":
      content = { type: "resource_link", uri: value.uri, name: value.name,
        ...optional(value, ["title", "description", "mimeType", "size"]) }; break;
    case "resource": {
      if (!record(value.resource)) invalid();
      const resource = value.resource;
      content = { type: "resource", resource: { uri: resource.uri, ...optional(resource, ["mimeType"]),
        ...("text" in resource ? { text: resource.text } : { blob: resource.blob }) } };
      break;
    }
    default: return invalid();
  }
  return nativeMcpContent([content])[0]!;
}

function optional(value: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, value[key]]));
}
function invalid(): never { throw new NativeOutputError("invalid_event"); }
