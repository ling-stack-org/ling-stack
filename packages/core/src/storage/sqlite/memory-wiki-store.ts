import type { MemoryWikiScope, MemoryWikiHumanBlock } from '@ling-stack/contracts';
import type { MemoryWikiGeneration, MemoryWikiStore } from '../../memory-wiki-types.js';
import type { MemoryDerivativeSource } from '../../memory-derivative-types.js';
import { DEFAULT_WORKSPACE_ID, type ChannelDecision } from '../../workspace-types.js';
import { mapChannelDecision } from './channel-collaboration-mappers.js';
import { channelDecisionSelectSql } from './select-sql.js';
import { mapMemoryObject, mapMemorySelfImprovingMetadata } from './memory-mappers.js';
import { memoryObjectSelectSql, memorySelfImprovingMetadataSelectSql } from './select-sql.js';
import type { SqliteStoreContext } from './store-context.js';
import type { SqliteRunStoreMigrationContext } from './migrations.js';

export function applyMemoryWikiMigration(context: SqliteRunStoreMigrationContext): void {
  if (context.hasMigration(188)) return;
  context.database.exec('SAVEPOINT memory_wiki_migration');
  try {
    context.database.exec(`CREATE TABLE IF NOT EXISTS memory_wiki_generations(scope_key TEXT PRIMARY KEY, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
      CREATE TABLE IF NOT EXISTS memory_wiki_human_blocks(scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL);`);
    context.recordMigration(188, 'rebuildable_scoped_memory_wiki');
    context.database.exec('RELEASE memory_wiki_migration');
  } catch (error) {
    context.database.exec('ROLLBACK TO memory_wiki_migration; RELEASE memory_wiki_migration'); throw error;
  }
}

export class SqliteMemoryWikiStore implements MemoryWikiStore {
  constructor(private readonly context: SqliteStoreContext) {}
  listMemoryWikiDecisions(channelId: string, afterId = '', limit = 64): ChannelDecision[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('memory_wiki_limit_invalid');
    return this.context.database.prepare(channelDecisionSelectSql(`WHERE workspace_id=? AND channel_id=? AND status='active'
      AND created_by='local-user' AND id>? ORDER BY id LIMIT ?`)).all(DEFAULT_WORKSPACE_ID, channelId, afterId, limit).map(mapChannelDecision);
  }
  listMemoryWikiSources(scope: MemoryWikiScope, afterId = '', limit = 64): MemoryDerivativeSource[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('memory_wiki_limit_invalid');
    return this.transaction(() => this.context.database.prepare(memoryObjectSelectSql(`WHERE workspace_id=? AND scope_type=? AND owner_id=?
      AND enabled=1 AND review_state='active' AND sensitivity!='secret-adjacent' AND id>? ORDER BY id LIMIT ?`))
      .all(DEFAULT_WORKSPACE_ID, scope.scopeType, scope.ownerId, afterId, limit).map(row => {
        const memory = mapMemoryObject(row);
        const health = this.context.database.prepare(memorySelfImprovingMetadataSelectSql('WHERE memory_id=?')).get(memory.id);
        const version = this.context.database.prepare('SELECT revision,content_updated_at FROM memory_derivative_revisions WHERE memory_id=?').get(memory.id);
        return {memory, revision: Number(version?.revision ?? 0), contentUpdatedAt: version ? String(version.content_updated_at) : undefined,
          health: health ? mapMemorySelfImprovingMetadata(health) : undefined};
      }));
  }
  getMemoryWikiGeneration(scopeKey: string): MemoryWikiGeneration | undefined {
    const row = this.context.database.prepare('SELECT record_json FROM memory_wiki_generations WHERE scope_key=?').get(scopeKey);
    return row ? JSON.parse(String(row.record_json)) as MemoryWikiGeneration : undefined;
  }
  beginMemoryWikiGeneration(scopeKey: string): number {
    return this.transaction(() => {
      const current = this.getMemoryWikiGeneration(scopeKey);
      const next = {...current, generation: (current?.generation ?? 0) + 1};
      this.context.database.prepare('INSERT INTO memory_wiki_generations VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record_json=excluded.record_json')
        .run(scopeKey, JSON.stringify(next));
      return next.generation;
    });
  }
  publishMemoryWikiGeneration(scopeKey: string, generation: number, fingerprint: string, directory: string): boolean {
    return this.transaction(() => {
      if (this.getMemoryWikiGeneration(scopeKey)?.generation !== generation) return false;
      this.context.database.prepare('UPDATE memory_wiki_generations SET record_json=? WHERE scope_key=?')
        .run(JSON.stringify({generation, published: generation, fingerprint, directory}), scopeKey);
      return true;
    });
  }
  getMemoryWikiHumanBlock(scopeKey: string): MemoryWikiHumanBlock {
    const row = this.context.database.prepare('SELECT revision,text FROM memory_wiki_human_blocks WHERE scope_key=?').get(scopeKey);
    return row ? {revision: Number(row.revision), text: String(row.text)} : {revision: 0, text: ''};
  }
  updateMemoryWikiHumanBlock(scopeKey: string, expectedRevision: number, text: string): MemoryWikiHumanBlock {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof text !== 'string' || Buffer.byteLength(text) > 16384) throw new Error('memory_wiki_human_invalid');
    return this.transaction(() => {
      const current = this.getMemoryWikiHumanBlock(scopeKey);
      if (current.revision !== expectedRevision) throw new Error('memory_wiki_human_conflict');
      const next = {revision: current.revision + 1, text};
      this.context.database.prepare('INSERT INTO memory_wiki_human_blocks VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,text=excluded.text')
        .run(scopeKey, next.revision, text);
      return next;
    });
  }
  private transaction<T>(action: () => T): T {
    this.context.database.exec('SAVEPOINT memory_wiki_write');
    try {const value = action(); this.context.database.exec('RELEASE memory_wiki_write'); return value;}
    catch (error) {this.context.database.exec('ROLLBACK TO memory_wiki_write; RELEASE memory_wiki_write'); throw error;}
  }
}
