import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {createSqliteRunStore} from '../dist/index.js';
async function fixture(t){const cwd=await mkdtemp(join(tmpdir(),'ling-derivatives-'));const store=createSqliteRunStore(cwd);
 const db=new DatabaseSync(store.paths.databasePath);t.after(async()=>{db.close();store.close();await rm(cwd,{recursive:true,force:true});});
 const now=new Date().toISOString();const create=(id,extra={})=>store.createMemoryObject({id,scopeType:'workspace',ownerId:'workspace_default',
  title:id,body:'Approved receipt knowledge',...extra},now);
 return {store,db,create,now};}
test('derivative source eligibility and monotonic revisions cover source/health mutations, excluding usage writes',async t=>{
 const f=await fixture(t);f.create('source');
 const first=f.store.getMemoryDerivativeSource('source');const sequence=f.store.getMemoryDerivativeSequence();
 f.store.recordUsedMemoryEvent({memoryIds:['source'],intent:'search',recallQuery:'receipt',policyVersion:'test'},f.now);
 assert.equal(f.store.getMemoryDerivativeSource('source').revision,first.revision);
 assert.equal(f.store.getMemoryDerivativeSequence(),sequence);
 f.store.updateMemoryObject('source',{body:'Changed receipt knowledge'},f.now);
 assert.ok(f.store.getMemoryDerivativeSource('source').revision>first.revision);
 assert.equal(f.store.listMemoryDerivativeChanges(0).length,1,'coalesced source outbox');
 f.store.upsertMemorySelfImprovingMetadata({memoryId:'source',kind:'workflow_lesson',trigger:'manual_review',lesson:'expired',validUntil:'2000-01-01T00:00:00Z'});
 assert.equal(f.store.getMemoryDerivativeSource('source'),undefined);
 // Value: protects=health UPSERTs coalesce with increasing outbox sequence; fails_when=repeat health updates conflict or retain stale qualification; why_new=source update coverage does not exercise outer SQLite UPSERT triggers; seam=none; no_claim=packaged SQLite acceptance.
 const expiredSequence=f.store.getMemoryDerivativeSequence();
 f.store.upsertMemorySelfImprovingMetadata({memoryId:'source',kind:'workflow_lesson',trigger:'manual_review',lesson:'restored',validUntil:null});
 assert.ok(f.store.getMemoryDerivativeSequence()>expiredSequence);
 assert.ok(f.store.getMemoryDerivativeSource('source').revision>first.revision);
 assert.equal(f.store.listMemoryDerivativeChanges(0).length,1);
 f.store.upsertMemorySelfImprovingMetadata({memoryId:'source',kind:'workflow_lesson',trigger:'manual_review',lesson:'replaced',supersededBy:'replacement'});
 assert.equal(f.store.getMemoryDerivativeSource('source'),undefined);
 for(const [id,extra] of [['candidate',{reviewState:'candidate'}],['disabled',{enabled:false}],['secret',{sensitivity:'secret-adjacent'}]]){
  f.create(id,extra);assert.equal(f.store.getMemoryDerivativeSource(id),undefined);
 }
 assert.deepEqual(f.store.listMemoryDerivativeSources(),[]);
});
test('outbox mutations roll back with their source and failed policy/generation CAS cannot publish',async t=>{
 const f=await fixture(t);f.create('source');const before=f.store.getMemoryDerivativeSequence();
 f.db.exec('BEGIN IMMEDIATE');f.db.prepare("UPDATE memory_objects SET body='uncommitted' WHERE id='source'").run();f.db.exec('ROLLBACK');
 assert.equal(f.store.getMemoryDerivativeSequence(),before);
 assert.equal(f.store.getMemoryDerivativeSource('source').memory.body,'Approved receipt knowledge');
 const config={mode:'lancedb',providerPresetId:'local',model:'model',dimensions:3,maxDistance:0.2,expectedRevision:0};
 const policy=f.store.updateMemorySemanticPolicy(config);
 assert.throws(()=>f.store.updateMemorySemanticPolicy(config),/conflict/);
 const old=f.store.beginMemorySemanticGeneration(policy.revision,'old','memory_old');
 const current=f.store.beginMemorySemanticGeneration(policy.revision,'new','memory_new');
 assert.equal(f.store.advanceMemorySemanticGeneration(old.generation,policy.revision,before,true),false);
 assert.equal(f.store.advanceMemorySemanticGeneration(current.generation,policy.revision,before,true),true);
 assert.deepEqual(f.store.listMemoryDerivativeChanges(0),[]);
 f.create('later');assert.ok(f.store.getMemoryDerivativeSequence()>before);
 f.store.updateMemorySemanticPolicy({mode:'off',expectedRevision:policy.revision});
 assert.equal(f.store.advanceMemorySemanticGeneration(current.generation,policy.revision,f.store.getMemoryDerivativeSequence(),true),false);
});
test('source keyset pages have no 500-record ceiling and return one coherent content/revision snapshot',async t=>{
 const f=await fixture(t);for(let i=0;i<513;i++)f.create(`source_${String(i).padStart(4,'0')}`);
 let after='',count=0;while(true){const page=f.store.listMemoryDerivativeSources(after,128);if(!page.length)break;
  count+=page.length;after=page.at(-1).memory.id;assert.ok(page.every(s=>s.revision>0));}
 assert.equal(count,513);assert.throws(()=>f.store.listMemoryDerivativeSources('',257),/limit_invalid/);
});
