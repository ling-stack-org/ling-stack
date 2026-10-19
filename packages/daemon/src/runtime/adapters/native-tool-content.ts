import { ContentBlockSchema, type ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { NativeOutputError } from "./native-stream-redaction.js";

/** Returned native content is evidence, never permission to fetch a URL or read a path. */
export function nativeMcpContent(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > 256) throw new NativeOutputError("capacity_exceeded");
  return value.map(part => {
    const parsed = ContentBlockSchema.safeParse(part);
    if (!parsed.success) invalid();
    const block = parsed.data;
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "image":
      case "audio":
        if (!block.mimeType.startsWith(`${block.type}/`)) invalid();
        return { type: block.type, data: nativeContentBase64(block.data), mimeType: block.mimeType };
      case "resource_link":
        return { type: "resource_link", uri: nativeContentUri(block.uri), name: block.name,
          ...(block.title !== undefined ? { title: block.title } : {}),
          ...(block.description !== undefined ? { description: block.description } : {}),
          ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}) };
      case "resource": {
        const resource = block.resource;
        const common = { uri: nativeContentUri(resource.uri), ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}) };
        return { type: "resource", resource: "text" in resource
          ? { ...common, text: resource.text } : { ...common, blob: nativeContentBase64(resource.blob) } };
      }
    }
  });
}

export function nativeContentUri(value: string, protocols?: readonly string[]): string {
  if (!value || /[\x00-\x20\x7f]/.test(value)) invalid();
  let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.username || url.password || (protocols && !protocols.includes(url.protocol))
    || ["javascript:", "data:", "blob:", "vbscript:"].includes(url.protocol)) invalid();
  return value;
}

export function nativeContentBase64(value: string): string {
  const decoded = Buffer.from(value, "base64");
  if (!decoded.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) invalid();
  return decoded.toString("base64");
}

function invalid(): never { throw new NativeOutputError("invalid_event"); }
