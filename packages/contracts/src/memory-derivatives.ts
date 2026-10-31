/** Optional derived retrieval. SQLite memories and owner qualifications remain authoritative. */
export interface MemorySemanticPolicy {
  readonly revision: number;
  readonly mode: 'off' | 'lancedb';
  readonly providerPresetId?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly allowRemote?: boolean;
  readonly allowPrivateRemote?: boolean;
  readonly timeoutMs?: number;
  /** Cosine-distance acceptance threshold calibrated for the selected embedding model. */
  readonly maxDistance?: number;
}
export type MemorySemanticPolicyUpdate = Omit<MemorySemanticPolicy, 'revision'> & { readonly expectedRevision: number };
export interface MemorySemanticStatus {
  readonly status: 'not_configured' | 'rebuilding' | 'ready' | 'degraded' | 'unavailable';
  readonly optional: true;
  readonly identity?: string;
  readonly reason?: string;
}
export interface MemorySemanticPolicyResponse {
  readonly cwd: string;
  readonly policy: MemorySemanticPolicy;
  readonly status: MemorySemanticStatus;
}
