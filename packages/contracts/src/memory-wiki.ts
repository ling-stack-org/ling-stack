import type { MemoryScopeType, MemorySourceRef } from './memory.js';

/** Exact owner partition; no implicit shared/private unions or cross-partition backlinks. */
export interface MemoryWikiScope {readonly scopeType: MemoryScopeType; readonly ownerId: string}
export interface MemoryWikiPage {
  readonly id: string;
  readonly sourceType: 'memory' | 'decision';
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly scope: MemoryWikiScope;
  readonly title: string;
  readonly body: string;
  readonly evidence: readonly MemorySourceRef[];
  readonly confidence: 'reviewed_unscored' | 'user_confirmed';
  readonly tags: readonly string[];
  readonly updatedAt: string;
  readonly relatedIds: readonly string[];
}
export interface MemoryWikiReport {
  readonly sourceId: string;
  readonly kind: 'marked_conflict' | 'missing_evidence' | 'expired' | 'superseded';
  readonly title: string;
}
export interface MemoryWikiIndexEntry {readonly key: string; readonly pageIds: readonly string[]}
export interface MemoryWikiHumanBlock {readonly revision: number; readonly text: string}
export interface MemoryWikiResponse {
  readonly cwd: string;
  readonly scope: MemoryWikiScope;
  readonly status: 'not_compiled' | 'ready' | 'stale' | 'unavailable';
  readonly generation?: number;
  readonly fingerprint?: string;
  readonly pages: readonly MemoryWikiPage[];
  readonly topics: readonly MemoryWikiIndexEntry[];
  readonly sources: readonly MemoryWikiIndexEntry[];
  readonly reports: readonly MemoryWikiReport[];
  readonly human: MemoryWikiHumanBlock;
}
export interface MemoryWikiExportResponse {readonly fileName: string; readonly markdown: string; readonly generation: number}
