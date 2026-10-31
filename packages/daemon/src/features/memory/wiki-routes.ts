import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_WORKSPACE_ID, type RunStore } from '@ling-stack/core';
import type { MemoryWikiScope } from '@ling-stack/contracts';
import type { ResolvedDaemonConfig } from '../../config.js';
import { readJsonBody } from '../../shared/request.js';
import { writeJson } from '../../shared/response.js';
import { isRecord } from '../../shared/validation.js';
import { compileMemoryWiki, readMemoryWiki, exportMemoryWiki, wikiScopeKey } from './wiki-compiler.js';

export async function handleMemoryWikiRoute(input: {readonly request: IncomingMessage; readonly response: ServerResponse;
  readonly url: URL; readonly config: ResolvedDaemonConfig; readonly getStore: (cwd: string) => RunStore}): Promise<void> {
  const {request, response, url} = input, cwd = url.searchParams.get('cwd');
  if (!cwd) {writeJson(response, 400, {error: 'cwd_required'}); return;}
  try {
    const scopeType = url.searchParams.get('scopeType') ?? 'workspace';
    const ownerId = url.searchParams.get('ownerId') ?? (scopeType === 'workspace' ? DEFAULT_WORKSPACE_ID : '');
    if (!['workspace', 'channel', 'teammate', 'task', 'run'].includes(scopeType) || !ownerId || ownerId.length > 300) throw new Error('memory_wiki_scope_invalid');
    const scope = {scopeType, ownerId} as MemoryWikiScope, store = input.getStore(cwd);
    let result: unknown;
    if (request.method === 'GET' && url.pathname === '/memory/wiki') result = await readMemoryWiki(store, scope);
    else if (request.method === 'POST' && url.pathname === '/memory/wiki/compile') result = await compileMemoryWiki(store, scope);
    else if (request.method === 'GET' && url.pathname === '/memory/wiki/export') result = await exportMemoryWiki(store, scope);
    else if (request.method === 'PUT' && url.pathname === '/memory/wiki/human') {
      await readMemoryWiki(store, scope); // validates the current owner, even before first compilation
      const body = await readJsonBody(request, input.config.maxBodyBytes);
      if (!isRecord(body) || typeof body.text !== 'string' || !Number.isSafeInteger(body.expectedRevision)) throw new Error('memory_wiki_human_invalid');
      result = {human: store.updateMemoryWikiHumanBlock(wikiScopeKey(scope), Number(body.expectedRevision), body.text)};
    } else {writeJson(response, 405, {error: 'method_not_allowed'}); return;}
    writeJson(response, 200, result);
  } catch (error) {
    const code = error instanceof Error && /^memory_wiki_[a-z_]+$/.test(error.message) ? error.message : 'memory_wiki_request_failed';
    writeJson(response, code.endsWith('conflict') || code.endsWith('stale') ? 409 : 400, {error: code});
  }
}
