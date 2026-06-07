import type { ProviderExtensionMetadata } from "@ling-stack/plugin-sdk";
import { defaultMediaVendorDefinitions } from "./media-vendor-definitions.js";

export function listBuiltinProviderExtensions(): readonly ProviderExtensionMetadata[] {
  return defaultMediaVendorDefinitions.map((definition) => ({
    manifest: {
      id: `provider:media:${definition.kind}`,
      name: `${definition.displayName} Media Provider`,
      version: "0.1.0",
      kind: "provider",
      trustLevel: "internal",
      capabilities: [
        `provider-kind:${definition.kind}`,
        "provider-api:media-job",
        ...definition.capabilities.map((capability) => `media:${capability}`),
      ],
      requiredSecrets: [`env:${definition.kind.toUpperCase()}_API_KEY`],
    },
    providerKind: definition.kind,
    providerApi: "media-job",
    providerCapabilities: [...definition.capabilities],
    mediaOperations: [...definition.capabilities],
  }));
}

export function getBuiltinProviderExtension(id: string): ProviderExtensionMetadata | undefined {
  return listBuiltinProviderExtensions().find((extension) => extension.manifest.id === id);
}
