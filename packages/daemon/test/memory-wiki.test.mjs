import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {learningFixture} from './support/learning-review-fixture.mjs';
import {compileMemoryWiki,readMemoryWiki,exportMemoryWiki,projectMemoryWiki,wikiScopeKey} from '../dist/features/memory/wiki-compiler.js';

async function setup(t) {
  const f=await learningFixture(t), scope={scopeType:'channel',ownerId:f.channel.id};
  const create=(id,extra={})=>f.store.createMemoryObject({id,...scope,title:id,body:`Approved ${id} procedure`,tags:['receipts'],
    sourceRefs:[{type:'run-event',id:f.run.id}],...extra},f.now);
  return {...f,scope,create};
}
test('wiki compiles deterministic scoped topics/source/related indexes and confirmed decisions; usage does not stale content',async t=>{
  const f=await setup(t);f.create('one');f.create('two');
  f.create('private-sentinel',{scopeType:'teammate',ownerId:'other',sensitivity:'private'});
  f.create('candidate',{reviewState:'candidate'});f.create('disabled',{enabled:false});f.create('secret',{sensitivity:'secret-adjacent'});
  f.store.createChannelDecision({channelId:f.channel.id,title:'Confirmed receipt rule',decision:'Use signed date',createdBy:'local-user'},f.now);
  f.store.createChannelDecision({channelId:f.channel.id,title:'Unconfirmed draft sentinel',decision:'Unreviewed',createdBy:'assistant'},f.now);
  const before=projectMemoryWiki(f.store,f.scope), first=await compileMemoryWiki(f.store,f.scope);
  assert.equal(first.status,'ready');assert.equal(first.pages.length,3);assert.equal(first.topics[0].pageIds.length,1);
  assert.equal(first.pages.find(p=>p.sourceId==='one').relatedIds.length,1);
  assert.ok(!JSON.stringify(first).includes('sentinel'));assert.ok(first.pages.every(p=>p.scope.ownerId===f.channel.id));
  f.store.recordUsedMemoryEvent({memoryIds:['one'],intent:'search',recallQuery:'one',policyVersion:'test'},new Date(Date.now()+1000).toISOString());
  assert.deepEqual(projectMemoryWiki(f.store,f.scope),before);
  const second=await compileMemoryWiki(f.store,f.scope);assert.equal(second.fingerprint,first.fingerprint);assert.deepEqual(second.pages,first.pages);
  const markdown=await exportMemoryWiki(f.store,f.scope);assert.match(markdown.markdown,/Version:/);assert.ok(!markdown.markdown.includes('sentinel'));
});
test('revocation, content changes, expiry and owner moves invalidate cached pages and exports before rebuild',async t=>{
  const f=await setup(t);f.create('one');await compileMemoryWiki(f.store,f.scope);
  f.store.updateMemoryObject('one',{ownerId:'other'},f.now);
  const stale=await readMemoryWiki(f.store,f.scope);assert.equal(stale.status,'stale');assert.deepEqual(stale.pages,[]);assert.deepEqual(stale.sources,[]);
  await assert.rejects(exportMemoryWiki(f.store,f.scope),/not_ready/);
  const rebuilt=await compileMemoryWiki(f.store,f.scope);assert.equal(rebuilt.pages.length,0);
  f.create('expired');f.store.upsertMemorySelfImprovingMetadata({memoryId:'expired',kind:'workflow_lesson',trigger:'manual_review',lesson:'old',validUntil:'2000-01-01T00:00:00Z'});
  f.create('missing',{sourceRefs:[]});f.create('conflict',{tags:['conflict']});
  const report=await compileMemoryWiki(f.store,f.scope);
  assert.deepEqual(report.pages.map(p=>p.sourceId),['conflict']);assert.deepEqual(new Set(report.reports.map(r=>r.kind)),new Set(['expired','missing_evidence','marked_conflict']));
});
test('independent human blocks survive rebuilding and deleting derivatives, with revision conflicts preserving the current text',async t=>{
  const f=await setup(t);f.create('one');const key=wikiScopeKey(f.scope);
  f.store.updateMemoryWikiHumanBlock(key,0,'Human annotation; never an active memory');
  await compileMemoryWiki(f.store,f.scope);
  const dir=join(f.store.paths.rootDir,'memory','wiki');await rm(dir,{recursive:true});
  assert.equal((await readMemoryWiki(f.store,f.scope)).status,'unavailable');
  const rebuilt=await compileMemoryWiki(f.store,f.scope);assert.equal(rebuilt.human.text,'Human annotation; never an active memory');
  assert.throws(()=>f.store.updateMemoryWikiHumanBlock(key,0,'stale overwrite'),/conflict/);
  assert.equal(f.store.getMemoryObject('one').body,'Approved one procedure');assert.match((await exportMemoryWiki(f.store,f.scope)).markdown,/Human annotation/);
});
test('older concurrent generations cannot publish and tampered manifests cannot become authoritative content',async t=>{
  const f=await setup(t);f.create('one');
  const outcomes=await Promise.allSettled([compileMemoryWiki(f.store,f.scope),compileMemoryWiki(f.store,f.scope)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes[0].status,'rejected');
  const generation=f.store.getMemoryWikiGeneration(wikiScopeKey(f.scope));
  assert.equal(f.store.publishMemoryWikiGeneration(wikiScopeKey(f.scope),generation.generation-1,'old','old'),false);
  const partition=createHash('sha256').update(JSON.stringify(wikiScopeKey(f.scope))).digest('hex');
  const path=join(f.store.paths.rootDir,'memory','wiki',partition,generation.directory,'manifest.json');
  const manifest=JSON.parse(await readFile(path,'utf8'));manifest.pages[0].body='Tampered generated block';await writeFile(path,JSON.stringify(manifest));
  assert.equal((await readMemoryWiki(f.store,f.scope)).status,'unavailable');
  assert.equal((await compileMemoryWiki(f.store,f.scope)).pages[0].body,'Approved one procedure');
});
