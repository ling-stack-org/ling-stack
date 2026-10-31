import type { LingExtensionManifest } from "./manifest.js";

export interface MemoryProviderExtensionMetadata {
  readonly manifest: LingExtensionManifest<"memory">;
  readonly memoryProviderId: string;
  readonly scopeKinds: readonly string[];
}

/** Derived-only vector provider. The Host verifies every returned id/version against SQLite. */
export interface MemoryVectorChunkV1 {
  readonly memoryId: string;
  readonly scopeKey: string;
  readonly contentHash: string;
  readonly qualificationRevision: number;
  readonly validUntil: number;
  readonly vector: readonly number[];
}
export interface MemoryVectorHitV1 {
  readonly memoryId: string;
  readonly scopeKey: string;
  readonly contentHash: string;
  readonly qualificationRevision: number;
}
export interface MemoryVectorProviderV1 {
  readonly schemaVersion: 1;
  upsert(chunks: readonly MemoryVectorChunkV1[]): Promise<void>;
  remove(memoryIds: readonly string[]): Promise<void>;
  /** Scope and expiry filters must run BEFORE top-k. No source text is returned. */
  search(input: { readonly vector: readonly number[]; readonly scopeKeys: readonly string[];
    readonly maxResults: number; readonly maxDistance: number; readonly now: number }): Promise<readonly MemoryVectorHitV1[]>;
  status(): 'ready' | 'unavailable';
  close(): void;
}
