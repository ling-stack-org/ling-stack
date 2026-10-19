import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { NativeOutputError } from "../native-stream-redaction.js";
import { nativeContentBase64 as base64, nativeContentUri as safeUri } from "../native-tool-content.js";

export { nativeMcpContent as codexMcpContent } from "../native-tool-content.js";

/** Native content is evidence, never permission to fetch a URL or read a local path. */
export function codexDynamicContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > 256) throw new NativeOutputError("capacity_exceeded");
  return value.map(part => {
    if (!record(part)) invalid();
    if (part.type === "inputText") {
      if (typeof part.text !== "string") invalid();
      return { type: "text", text: part.text };
    }
    if (part.type === "inputImage") return mediaContent("image", part.imageUrl);
    if (part.type === "inputAudio") return mediaContent("audio", part.audioUrl);
    throw new NativeOutputError("unsupported_item");
  });
}

export function codexFunctionContent(value: unknown): { content: ContentBlock[]; opaqueContentCount: number } {
  if (typeof value === "string") return { content: [{ type: "text", text: value }], opaqueContentCount: 0 };
  if (!Array.isArray(value)) invalid();
  if (value.length > 256) throw new NativeOutputError("capacity_exceeded");
  const content: ContentBlock[] = [];
  let opaqueContentCount = 0;
  for (const part of value) {
    if (!record(part)) invalid();
    switch (part.type) {
      case "input_text":
        if (typeof part.text !== "string") invalid();
        content.push({ type: "text", text: part.text });
        break;
      case "input_image": content.push(mediaContent("image", part.image_url)); break;
      case "input_audio": content.push(mediaContent("audio", part.audio_url)); break;
      case "encrypted_content":
        if (typeof part.encrypted_content !== "string") invalid();
        opaqueContentCount += 1;
        break;
      default: throw new NativeOutputError("unsupported_item");
    }
  }
  return { content, opaqueContentCount };
}

function mediaContent(type: "image" | "audio", value: unknown): ContentBlock {
  if (typeof value !== "string" || !value || /[\x00-\x20\x7f]/.test(value)) invalid();
  if (value.startsWith("data:")) {
    const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || !match[1].startsWith(`${type}/`)) invalid();
    return { type, mimeType: match[1], data: base64(match[2]) };
  }
  const uri = safeUri(value, ["http:", "https:"]);
  return { type: "resource_link", uri, name: type };
}

function invalid(): never { throw new NativeOutputError("invalid_event"); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
