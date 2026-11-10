import type { MemoryWikiScope, MemoryWikiHumanBlock } from '@ling-stack/contracts';
import type { MemoryDerivativeSource } from './memory-derivative-types.js';
import type { ChannelDecision } from './workspace-types.js';
export interface MemoryWikiGeneration {
  readonly generation: number;
  readonly published?: number;
  readonly fingerprint?: string;
  readonly directory?: string;
}
export interface MemoryWikiStore {
  listMemoryWikiSources(scope: MemoryWikiScope, afterId?: string, limit?: number): MemoryDerivativeSource[];
  listMemoryWikiDecisions(channelId: string, afterId?: string, limit?: number): ChannelDecision[];
  getMemoryWikiGeneration(scopeKey: string): MemoryWikiGeneration | undefined;
  beginMemoryWikiGeneration(scopeKey: string): number;
  publishMemoryWikiGeneration(scopeKey: string, generation: number, fingerprint: string, directory: string): boolean;
  getMemoryWikiHumanBlock(scopeKey: string): MemoryWikiHumanBlock;
  updateMemoryWikiHumanBlock(scopeKey: string, expectedRevision: number, text: string): MemoryWikiHumanBlock;
}
