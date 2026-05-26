import {
  type LingExtensionKind,
  validateLingExtensionManifest,
} from "./manifest.js";
import type { AutomationExtensionMetadata } from "./automation.js";
import type { ChannelSourceExtensionMetadata } from "./channel-source.js";
import type { MemoryProviderExtensionMetadata } from "./memory.js";
import type { ProviderExtensionMetadata } from "./provider.js";
import type { RunnerExtensionMetadata } from "./runner.js";
import type { SkillPackExtensionMetadata } from "./skill-pack.js";
import type { ToolExtensionMetadata } from "./tool.js";

export type LingExtensionMetadata =
  | ProviderExtensionMetadata
  | RunnerExtensionMetadata
  | ChannelSourceExtensionMetadata
  | SkillPackExtensionMetadata
  | ToolExtensionMetadata
  | MemoryProviderExtensionMetadata
  | AutomationExtensionMetadata;

export type LingExtensionByKind<K extends LingExtensionKind> = Extract<
  LingExtensionMetadata,
  { readonly manifest: { readonly kind: K } }
>;

export interface ExtensionKindRegistry<K extends LingExtensionKind> {
  readonly kind: K;
  register(extension: LingExtensionByKind<K>): void;
  get(id: string): LingExtensionByKind<K> | undefined;
  has(id: string): boolean;
  list(): readonly LingExtensionByKind<K>[];
}

export interface LingExtensionRegistry {
  readonly providers: ExtensionKindRegistry<"provider">;
  readonly runners: ExtensionKindRegistry<"runner">;
  readonly channelSources: ExtensionKindRegistry<"channel-source">;
  readonly skillPacks: ExtensionKindRegistry<"skill-pack">;
  readonly tools: ExtensionKindRegistry<"tool">;
  readonly memoryProviders: ExtensionKindRegistry<"memory">;
  readonly automations: ExtensionKindRegistry<"automation">;
  register(extension: LingExtensionMetadata): void;
  get(id: string): LingExtensionMetadata | undefined;
  has(id: string): boolean;
  list(): readonly LingExtensionMetadata[];
  listByKind<K extends LingExtensionKind>(kind: K): readonly LingExtensionByKind<K>[];
}

export function createExtensionKindRegistry<K extends LingExtensionKind>(
  kind: K,
): ExtensionKindRegistry<K> {
  return new InMemoryExtensionKindRegistry(kind);
}

export function createLingExtensionRegistry(): LingExtensionRegistry {
  const extensionsById = new Map<string, LingExtensionMetadata>();
  const onRegister = (extension: LingExtensionMetadata): void => {
    const existing = extensionsById.get(extension.manifest.id);
    if (existing) {
      throw new Error(`Duplicate extension id: ${extension.manifest.id}`);
    }
    extensionsById.set(extension.manifest.id, extension);
  };

  const providers = new InMemoryExtensionKindRegistry("provider", onRegister);
  const runners = new InMemoryExtensionKindRegistry("runner", onRegister);
  const channelSources = new InMemoryExtensionKindRegistry("channel-source", onRegister);
  const skillPacks = new InMemoryExtensionKindRegistry("skill-pack", onRegister);
  const tools = new InMemoryExtensionKindRegistry("tool", onRegister);
  const memoryProviders = new InMemoryExtensionKindRegistry("memory", onRegister);
  const automations = new InMemoryExtensionKindRegistry("automation", onRegister);

  return {
    providers,
    runners,
    channelSources,
    skillPacks,
    tools,
    memoryProviders,
    automations,
    register(extension: LingExtensionMetadata): void {
      kindRegistryFor(extension.manifest.kind).register(extension as never);
    },
    get(id: string): LingExtensionMetadata | undefined {
      return extensionsById.get(id);
    },
    has(id: string): boolean {
      return extensionsById.has(id);
    },
    list(): readonly LingExtensionMetadata[] {
      return Object.freeze([...extensionsById.values()]);
    },
    listByKind<K extends LingExtensionKind>(kind: K): readonly LingExtensionByKind<K>[] {
      return kindRegistryFor(kind).list() as readonly LingExtensionByKind<K>[];
    },
  };

  function kindRegistryFor<K extends LingExtensionKind>(kind: K): ExtensionKindRegistry<K> {
    switch (kind) {
      case "provider":
        return providers as unknown as ExtensionKindRegistry<K>;
      case "runner":
        return runners as unknown as ExtensionKindRegistry<K>;
      case "channel-source":
        return channelSources as unknown as ExtensionKindRegistry<K>;
      case "skill-pack":
        return skillPacks as unknown as ExtensionKindRegistry<K>;
      case "tool":
        return tools as unknown as ExtensionKindRegistry<K>;
      case "memory":
        return memoryProviders as unknown as ExtensionKindRegistry<K>;
      case "automation":
        return automations as unknown as ExtensionKindRegistry<K>;
    }
  }
}

class InMemoryExtensionKindRegistry<K extends LingExtensionKind> implements ExtensionKindRegistry<K> {
  readonly kind: K;
  private readonly extensions = new Map<string, LingExtensionByKind<K>>();
  private readonly onRegister?: (extension: LingExtensionMetadata) => void;

  constructor(kind: K, onRegister?: (extension: LingExtensionMetadata) => void) {
    this.kind = kind;
    this.onRegister = onRegister;
  }

  register(extension: LingExtensionByKind<K>): void {
    validateLingExtensionManifest(extension.manifest, this.kind);
    const id = extension.manifest.id;
    if (this.extensions.has(id)) {
      throw new Error(`Duplicate extension id: ${id}`);
    }
    this.onRegister?.(extension);
    this.extensions.set(id, extension);
  }

  get(id: string): LingExtensionByKind<K> | undefined {
    return this.extensions.get(id);
  }

  has(id: string): boolean {
    return this.extensions.has(id);
  }

  list(): readonly LingExtensionByKind<K>[] {
    return Object.freeze([...this.extensions.values()]);
  }
}
