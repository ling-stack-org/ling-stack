import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {learningFixture} from './support/learning-review-fixture.mjs';
import {MemorySemanticService} from '../dist/features/memory/semantic-service.js';
import {registerMemorySemanticService} from '../dist/features/memory/semantic-registry.js';
import {openLanceMemoryProvider} from '../dist/features/memory/lancedb-provider.js';
import {recallMemory} from '../dist/features/memory/recall-service.js';
const modulePath=process.env.LING_TEST_LANCEDB_MODULE;
const resolver={resolve(){return {status:'not_required'};}};
async function setup(t,embed,{timeoutMs=1000}={}){
 const f=await learningFixture(t);
 const preset=f.store.createProviderPreset({kind:'openai-compatible',displayName:'Local fixture',providerId:'fixture',model:'fixture',api:'openai-completions',
  baseUrl:'http://127.0.0.1:1/v1',authHeader:false,reasoning:false,capabilities:['chat'],enabled:true},f.now);
 f.store.updateMemorySemanticPolicy({mode:'lancedb',expectedRevision:0,providerPresetId:preset.id,model:'synthetic-fixture',dimensions:3,maxDistance:0.1,timeoutMs});
 const require=createRequire(import.meta.url);const load=async()=>require(modulePath);
 const service=new MemorySemanticService({store:f.store,secretResolver:resolver,embed,
  open:options=>openLanceMemoryProvider({...options,load})});
 registerMemorySemanticService(f.store,service);t.after(async()=>{service.beginShutdown();await service.drain();});
 const create=(id,extra={})=>f.store.createMemoryObject({id,scopeType:'channel',ownerId:f.channel.id,title:'Approved period convention',body:'Use the signed receipt date.',...extra},f.now);
 return {...f,preset,service,create,request:{runId:f.run.id,intent:'task-run',query:'paraphrased synthetic fixture',maxResults:6}};
}
const native=t=>{if(!modulePath){t.skip('Optional LanceDB native module not configured');return false;}return true;};
test('native-backed service indexes only qualified sources, fuses scoped hits, persists checkpoints and removes revoked sources',async t=>{
 if(!native(t))return;let calls=0;
 const f=await setup(t,async({texts})=>{calls++;return texts.map(()=>[1,0,0]);});
 f.create('mine');f.create('foreign',{ownerId:'other'});f.create('candidate',{reviewState:'candidate'});f.create('secret',{sensitivity:'secret-adjacent'});
 await f.service.refresh();assert.equal(f.service.status().status,'ready');
 const result=await recallMemory(f.store,f.request);assert.deepEqual(result.memories.map(x=>x.memory.id),['mine']);
 assert.match(result.policyVersion,/rrf-v1/);assert.equal(result.audit.semanticCandidateCount,1);
 const before=calls;f.store.recordUsedMemoryEvent({memoryIds:['mine'],intent:'task-run',recallQuery:'x',policyVersion:'test'},f.now);
 await f.service.refresh();assert.equal(calls,before,'usage never causes re-embedding');
 f.store.updateMemoryObject('mine',{enabled:false},new Date().toISOString());
 assert.deepEqual((await recallMemory(f.store,f.request)).memories,[],'SQLite revocation wins before index deletion');
 await f.service.refresh();assert.deepEqual(f.store.listMemoryDerivativeChanges(f.store.getMemorySemanticGeneration().checkpoint),[]);
 f.store.updateMemorySemanticPolicy({mode:'off',expectedRevision:1});
 assert.equal(f.service.status().status,'not_configured');assert.deepEqual((await recallMemory(f.store,f.request)).memories,[]);
});
test('semantic deadline includes embedding and an uncooperative late result cannot supply stale source content',async t=>{
 if(!native(t))return;let delayed=false,release;
 const f=await setup(t,async({texts})=>{if(delayed)await new Promise(resolve=>{release=resolve;});return texts.map(()=>[1,0,0]);},{timeoutMs:50});
 f.create('mine');await f.service.refresh();delayed=true;
 const started=Date.now();const pending=recallMemory(f.store,{...f.request,query:'receipt'});
 while(!release)await new Promise(resolve=>setTimeout(resolve,1));
 f.store.updateMemoryObject('mine',{reviewState:'archived'},new Date().toISOString());
 const result=await pending;assert.ok(Date.now()-started<500);assert.deepEqual(result.memories,[]);
 assert.equal(f.service.status().status,'degraded');release();
});
test('source content hash, expiry and scope moves defeat stale vector hits; identity changes create a separate namespace',async t=>{
 if(!native(t))return;
 const f=await setup(t,async({texts})=>texts.map(()=>[1,0,0]));
 f.create('mine');await f.service.refresh();const generation=f.store.getMemorySemanticGeneration();
 f.store.updateMemoryObject('mine',{ownerId:'other',body:'Foreign changed text'},new Date().toISOString());
 assert.deepEqual((await recallMemory(f.store,f.request)).memories,[]);
 f.store.updateMemorySemanticPolicy({...f.store.getMemorySemanticPolicy(),model:'different-synthetic-model',expectedRevision:1});
 await f.service.refresh();const changed=f.store.getMemorySemanticGeneration();
 assert.notEqual(changed.identity,generation.identity);assert.notEqual(changed.tableName,generation.tableName);
});
test('missing optional native module degrades without affecting lexical recall or startup',async t=>{
 const f=await learningFixture(t);
 const preset=f.store.createProviderPreset({kind:'openai-compatible',displayName:'Local fixture',providerId:'fixture',model:'fixture',api:'openai-completions',
  baseUrl:'http://127.0.0.1:1/v1',authHeader:false,reasoning:false,capabilities:['chat'],enabled:true},f.now);
 f.store.updateMemorySemanticPolicy({mode:'lancedb',expectedRevision:0,providerPresetId:preset.id,model:'fixture',dimensions:3,maxDistance:0.1});
 f.store.createMemoryObject({id:'lexical',scopeType:'channel',ownerId:f.channel.id,title:'receipt sentinel',body:'Local result'},f.now);
 const service=new MemorySemanticService({store:f.store,secretResolver:resolver,open:async()=>{throw new Error('native_unavailable');}});
 registerMemorySemanticService(f.store,service);t.after(async()=>{service.beginShutdown();await service.drain();});
 await service.refresh();assert.equal(service.status().status,'unavailable');
 assert.deepEqual((await recallMemory(f.store,{runId:f.run.id,intent:'task-run',query:'receipt sentinel'})).memories.map(x=>x.memory.id),['lexical']);
});
