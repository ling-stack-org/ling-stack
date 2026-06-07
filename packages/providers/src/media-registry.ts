import type { DefaultMediaAdapterRegistryOptions, MediaAdapterFactory, MediaAdapterProviderConfig, MediaAdapterRegistryOptions, MediaAdapterResolution } from "./types.js";
import { createStaticMediaAdapter, createStaticVendorMediaAdapterFactory } from "./media-static.js";
import { defaultMediaVendorAdapterDefinitions } from "./media-vendor-definitions.js";

export class MediaAdapterRegistry {
  private readonly factoriesByKind = new Map<string, MediaAdapterFactory>();
  private readonly enableStaticFallback: boolean;

  constructor(options: MediaAdapterRegistryOptions = {}) {
    this.enableStaticFallback = options.enableStaticFallback ?? true;
    for (const factory of options.factories ?? []) {
      this.register(factory);
    }
  }

  register(factory: MediaAdapterFactory): void {
    for (const kind of factory.providerKinds) {
      this.factoriesByKind.set(kind, factory);
    }
  }

  resolve(provider: MediaAdapterProviderConfig): MediaAdapterResolution {
    if (provider.api !== "media-job") {
      return {
        ok: false,
        errorCode: "unsupported_capability",
        errorMessage: "Media adapters require a media-job provider preset.",
      };
    }

    const factory = this.factoriesByKind.get(provider.kind);
    if (factory) {
      return {
        ok: true,
        adapter: factory.create(provider),
      };
    }

    if (this.enableStaticFallback) {
      return {
        ok: true,
        adapter: createStaticMediaAdapter(),
      };
    }

    return {
      ok: false,
      errorCode: "unsupported_capability",
      errorMessage: `No media adapter is registered for provider kind ${provider.kind}.`,
    };
  }
}

export function createDefaultMediaAdapterRegistry(options: DefaultMediaAdapterRegistryOptions = {}): MediaAdapterRegistry {
  return new MediaAdapterRegistry({
    enableStaticFallback: options.enableStaticFallback,
    factories: defaultMediaVendorAdapterDefinitions().map((definition) =>
      createStaticVendorMediaAdapterFactory(definition.kind, definition.displayName, {
        transport: options.mediaVendorTransport,
      }),
    ),
  });
}

export function resolveMediaAdapter(registry: MediaAdapterRegistry, provider: MediaAdapterProviderConfig): MediaAdapterResolution {
  return registry.resolve(provider);
}
