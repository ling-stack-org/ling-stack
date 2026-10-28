import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_WORKSPACE_ID, type RunStore } from '@ling-stack/core';
import type { MemoryWikiScope, MemoryWikiResponse, MemoryWikiPage, MemoryWikiReport, MemoryWikiIndexEntry } from '@ling-stack/contracts';
import { memorySourceHash } from './semantic-service.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const wikiScopeKey = (scope: MemoryWikiScope): string => JSON.stringify([DEFAULT_WORKSPACE_ID, scope.scopeType, scope.ownerId]);
function assertScope(store: RunStore, scope: MemoryWikiScope): void {
  const owner = scope.scopeType === 'workspace' ? scope.ownerId === DEFAULT_WORKSPACE_ID :
    scope.scopeType === 'channel' ? store.getChannel(scope.ownerId)?.status === 'active' :
    scope.scopeType === 'teammate' ? store.getAiTeammate(scope.ownerId)?.status === 'active' :
    scope.scopeType === 'task' ? store.getTask(scope.ownerId) :
    scope.scopeType === 'run' ? store.getRun(scope.ownerId) : undefined;
  if (!owner) throw new Error('memory_wiki_scope_unavailable');
}
type Projection = Pick<MemoryWikiResponse, 'pages' | 'reports' | 'topics' | 'sources'> & {readonly fingerprint: string};
function index(values: readonly {key: string; id: string}[]): MemoryWikiIndexEntry[] {
  const entries = new Map<string, Set<string>>();
  for (const {key, id} of values) {const ids = entries.get(key) ?? new Set<string>(); ids.add(id); entries.set(key, ids);}
  return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, ids]) => ({key, pageIds: [...ids].sort()}));
}

/** Deterministic projection of an exact owner. No model, repository crawl, or cross-owner traversal. */
export function projectMemoryWiki(store: RunStore, scope: MemoryWikiScope): Projection {
  assertScope(store, scope);
  const pages: MemoryWikiPage[] = [], reports: MemoryWikiReport[] = [];
  let after = '';
  while (true) {
    const sources = store.listMemoryWikiSources(scope, after, 128);
    if (!sources.length) break;
    for (const source of sources) {
      const {memory: m, health} = source;
      const expired = health?.validUntil && (!Number.isFinite(Date.parse(health.validUntil)) || Date.parse(health.validUntil) <= Date.now());
      const missing = m.sourceRefs.length === 0 || m.sourceRefs.every(ref => ref.type === 'manual' && ref.id === m.id && ref.label === 'Manual memory');
      if (expired) reports.push({sourceId: m.id, title: m.title, kind: 'expired'});
      if (health?.supersededBy) reports.push({sourceId: m.id, title: m.title, kind: 'superseded'});
      if (missing) reports.push({sourceId: m.id, title: m.title, kind: 'missing_evidence'});
      if (m.tags.some(tag => ['conflict', 'contradiction', '矛盾'].includes(tag.toLowerCase()))) reports.push({sourceId: m.id, title: m.title, kind: 'marked_conflict'});
      if (expired || health?.supersededBy || missing) continue;
      // The approved memory is the cited source. Do not turn arbitrary sourceRef labels/ids
      // into cross-owner backlink indexes; follow the memory's provenance in its own review UI.
      pages.push({id: `memory-${hash(m.id).slice(0, 24)}`, sourceType: 'memory', sourceId: m.id,
        sourceVersion: `${source.revision}:${memorySourceHash(source)}`, scope, title: m.title, body: m.body,
        evidence: [{type: 'manual', id: m.id, label: 'Approved memory'}], confidence: 'reviewed_unscored',
        tags: [...m.tags].sort(), updatedAt: source.contentUpdatedAt ?? m.updatedAt, relatedIds: []});
    }
    after = sources.at(-1)!.memory.id;
  }
  if (scope.scopeType === 'channel') {
    after = '';
    while (true) {
      const decisions = store.listMemoryWikiDecisions(scope.ownerId, after, 128);
      if (!decisions.length) break;
      for (const d of decisions) pages.push({id: `decision-${hash(d.id).slice(0, 24)}`, sourceType: 'decision', sourceId: d.id,
        sourceVersion: hash(d), scope, title: d.title, body: `${d.decision}\n\n${d.rationale}`.trim(), evidence: [{type: 'decision', id: d.id}],
        confidence: 'user_confirmed', tags: ['decisions'], updatedAt: d.updatedAt, relatedIds: []});
      after = decisions.at(-1)!.id;
    }
  }
  pages.sort((a, b) => a.id.localeCompare(b.id));
  reports.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.kind.localeCompare(b.kind));
  const topics = index(pages.flatMap(p => p.tags.map(key => ({key, id: p.id}))));
  // Shared topics establish associations only, never a claim of agreement or entailment.
  const topicIds = new Map(topics.map(topic => [topic.key, topic.pageIds]));
  const related = pages.map(p => ({...p, relatedIds: [...new Set(p.tags.flatMap(tag => (topicIds.get(tag) ?? []).slice(0, 21)))].filter(id => id !== p.id).sort().slice(0, 20)}));
  const sources = index(pages.map(p => ({key: `${p.sourceType}:${p.sourceId}`, id: p.id})));
  const projection = {pages: related, topics, sources, reports};
  return {...projection, fingerprint: hash(projection)};
}

interface Manifest extends Projection {readonly schemaVersion: 1; readonly generation: number; readonly scopeKey: string}
const directoryFor = (store: RunStore, key: string): string => join(store.paths.rootDir, 'memory', 'wiki', hash(key));
export async function compileMemoryWiki(store: RunStore, scope: MemoryWikiScope): Promise<MemoryWikiResponse> {
  const projection = projectMemoryWiki(store, scope);
  const key = wikiScopeKey(scope), generation = store.beginMemoryWikiGeneration(key);
  const directory = `generation-${generation}-${randomUUID()}`, root = directoryFor(store, key);
  const staging = join(root, `${directory}.staging`), published = join(root, directory);
  await mkdir(staging, {recursive: true, mode: 0o700});
  const manifest: Manifest = {...projection, schemaVersion: 1, generation, scopeKey: key};
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest), {mode: 0o600});
  for (const page of projection.pages) await writeFile(join(staging, `${page.id}.md`), renderPage(page), {mode: 0o600});
  // A filesystem generation is immutable. SQLite publishes only the current request after
  // a second source check, so a slow old compiler cannot replace a newer generation.
  await rename(staging, published);
  if (projectMemoryWiki(store, scope).fingerprint !== projection.fingerprint ||
    !store.publishMemoryWikiGeneration(key, generation, projection.fingerprint, directory)) throw new Error('memory_wiki_compile_stale');
  return readMemoryWiki(store, scope);
}
export async function readMemoryWiki(store: RunStore, scope: MemoryWikiScope): Promise<MemoryWikiResponse> {
  const current = projectMemoryWiki(store, scope), key = wikiScopeKey(scope);
  const generation = store.getMemoryWikiGeneration(key), human = store.getMemoryWikiHumanBlock(key);
  const empty = {cwd: store.paths.cwd, scope, pages: [], topics: [], sources: [], reports: [], human};
  if (!generation?.directory || !generation.published) return {...empty, status: 'not_compiled'};
  if (generation.fingerprint !== current.fingerprint) return {...empty, status: 'stale'};
  if (!/^generation-\d+-[a-f0-9-]+$/.test(generation.directory)) return {...empty, status: 'unavailable'};
  try {
    const value: unknown = JSON.parse(await readFile(join(directoryFor(store, key), generation.directory, 'manifest.json'), 'utf8'));
    const record = value as Partial<Manifest>;
    if (record.schemaVersion !== 1 || record.scopeKey !== key || record.generation !== generation.published ||
      record.fingerprint !== current.fingerprint || hash({pages: record.pages, topics: record.topics, sources: record.sources, reports: record.reports}) !== current.fingerprint)
      return {...empty, status: 'unavailable'};
    // Recheck after disk I/O. Never return cached content following a revocation or owner change.
    if (projectMemoryWiki(store, scope).fingerprint !== current.fingerprint || store.getMemoryWikiGeneration(key)?.published !== generation.published) return {...empty, status: 'stale'};
    return {...empty, ...current, status: 'ready', generation: generation.published};
  } catch (error) {
    if (error instanceof Error && error.message === 'memory_wiki_scope_unavailable') throw error;
    return {...empty, status: 'unavailable'};
  }
}
function renderPage(page: MemoryWikiPage): string {
  return `# ${page.title}\n\n${page.body}\n\n---\nSource: ${page.sourceType}:${page.sourceId}\nVersion: ${page.sourceVersion}\nScope: ${page.scope.scopeType}:${page.scope.ownerId}\nConfidence: ${page.confidence}\nUpdated: ${page.updatedAt}\n\nRelated: ${page.relatedIds.join(', ')}\n`;
}
export async function exportMemoryWiki(store: RunStore, scope: MemoryWikiScope): Promise<{fileName: string; markdown: string; generation: number}> {
  const result = await readMemoryWiki(store, scope);
  if (result.status !== 'ready') throw new Error('memory_wiki_not_ready');
  const sections = result.pages.map(renderPage);
  const reports = result.reports.map(r => `- ${r.kind}: ${r.sourceId} — ${r.title}`).join('\n');
  return {fileName: `ling-wiki-${hash(wikiScopeKey(scope)).slice(0, 12)}.md`, generation: result.generation!,
    markdown: `# Ling Wiki\n\n${scope.scopeType}:${scope.ownerId}\n\n## Human notes\n\n${result.human.text}\n\n${sections.join('\n\n')}\n\n## Reports\n\n${reports}\n`};
}
