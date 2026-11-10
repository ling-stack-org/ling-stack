import type { MemoryObject, MemorySelfImprovingMetadata } from './memory-types.js';
import type { MemorySemanticPolicy, MemorySemanticPolicyUpdate } from '@ling-stack/contracts';
export type { MemorySemanticPolicy, MemorySemanticPolicyUpdate } from '@ling-stack/contracts';
export interface MemoryDerivativeSource {
  readonly memory: MemoryObject;
  readonly revision: number;
  readonly contentUpdatedAt?: string;
  readonly health?: MemorySelfImprovingMetadata;
}
export interface MemorySemanticGeneration {
  readonly generation: number;
  readonly policyRevision: number;
  readonly identity: string;
  readonly tableName: string;
  readonly checkpoint: number;
  readonly ready: boolean;
  readonly scanAfter?: string;
  readonly scanComplete?: boolean;
}
export interface MemoryDerivativeStore {
  getMemorySemanticPolicy(): MemorySemanticPolicy;
  updateMemorySemanticPolicy(input: MemorySemanticPolicyUpdate): MemorySemanticPolicy;
  /** Keyset pages, with no recency cutoff or arbitrary 500-object ceiling. */
  listMemoryDerivativeSources(afterId?: string, limit?: number): MemoryDerivativeSource[];
  getMemoryDerivativeSource(id: string): MemoryDerivativeSource | undefined;
  listMemoryDerivativeChanges(afterSequence: number, limit?: number): readonly { readonly sequence: number; readonly memoryId: string }[];
  getMemoryDerivativeSequence(): number;
  getMemorySemanticGeneration(): MemorySemanticGeneration | undefined;
  beginMemorySemanticGeneration(policyRevision: number, identity: string, tableName: string): MemorySemanticGeneration;
  advanceMemorySemanticGeneration(generation: number, policyRevision: number, checkpoint: number, ready: boolean): boolean;
  advanceMemorySemanticScan(generation: number, policyRevision: number, afterId: string, complete: boolean): boolean;
}
