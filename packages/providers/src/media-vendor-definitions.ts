import type { MediaVendorAdapterDefinition } from "./types.js";

export function defaultMediaVendorAdapterDefinitions(): readonly MediaVendorAdapterDefinition[] {
  return defaultMediaVendorDefinitions;
}

export function getMediaVendorAdapterDefinition(kind: string): MediaVendorAdapterDefinition | undefined {
  return defaultMediaVendorDefinitions.find((definition) => definition.kind === kind);
}

export const defaultMediaVendorDefinitions: readonly MediaVendorAdapterDefinition[] = [
  {
    kind: "openai",
    displayName: "OpenAI Images",
    capabilities: ["image_generate"],
  },
  {
    kind: "openai-compatible",
    displayName: "OpenAI-compatible Images",
    capabilities: ["image_generate"],
  },
  {
    kind: "jimeng",
    displayName: "Jimeng",
    capabilities: ["image_generate", "image_edit"],
  },
  {
    kind: "seedream",
    displayName: "Seedream",
    capabilities: ["image_generate", "image_edit"],
  },
  {
    kind: "seedance",
    displayName: "Seedance",
    capabilities: ["video_generate"],
  },
];
