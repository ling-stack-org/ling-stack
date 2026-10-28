import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {learningFixture} from './support/learning-review-fixture.mjs';
import {embedMemoryText,embeddingConnection} from '../dist/features/memory/embedding-client.js';
import {MemorySemanticService} from '../dist/features/memory/semantic-service.js';
const secretResolver={resolve(){return {status:'not_required'};}};
async function setup(t,handler){
 const f=await learningFixture(t);const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const preset=f.store.createProviderPreset({kind:'openai-compatible',displayName:'Embedding transport fixture',providerId:'fixture',model:'fixture',api:'openai-completions',
  baseUrl:`http://127.0.0.1:${server.address().port}/v1`,authHeader:false,reasoning:false,capabilities:['chat'],enabled:true},f.now);
 const policy=f.store.updateMemorySemanticPolicy({expectedRevision:0,mode:'lancedb',providerPresetId:preset.id,model:'synthetic-fixture',dimensions:3,maxDistance:0.1});
 return {...f,preset,policy,embed:(texts,signal=new AbortController().signal)=>embedMemoryText({store:f.store,policy,secretResolver,texts,signal})};
}
test('real embeddings HTTP transport sends bounded model/input only and validates response order, dimensions and nonzero finite vectors',async t=>{
 let payload,mode='ok';const f=await setup(t,async(req,res)=>{
  assert.equal(req.url,'/v1/embeddings');let text='';for await(const chunk of req)text+=chunk;payload=JSON.parse(text);
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({data:mode==='ok'?[{index:1,embedding:[0,1,0]},{index:0,embedding:[1,0,0]}]:
   mode==='duplicate'?[{index:0,embedding:[1,0,0]},{index:0,embedding:[1,0,0]}]:[{index:0,embedding:[0,0,0]},{index:1,embedding:[1,0]}]}));
 });
 assert.deepEqual(await f.embed(['first','second']),[[1,0,0],[0,1,0]]);
 assert.deepEqual(Object.keys(payload).sort(),['dimensions','encoding_format','input','model']);
 for(mode of ['duplicate','invalid'])await assert.rejects(f.embed(['first','second']),/output_invalid/);
 await assert.rejects(f.embed(Array(33).fill('x')),/over_budget/);
});
test('transport abort and redirects are rejected without hidden retries',async t=>{
 let calls=0;const f=await setup(t,(_req,res)=>{calls++;res.writeHead(302,{location:'http://127.0.0.1:1/stolen'});res.end();});
 await assert.rejects(f.embed(['query']));assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(f.embed(['query'],controller.signal));assert.equal(calls,1);
});
test('remote opt-in and private owner data policy apply before embedding; disabling a provider rejects results',async t=>{
 const f=await setup(t,()=>{});
 f.store.updateProviderPreset(f.preset.id,{baseUrl:'https://embedding.example/v1'},new Date(Date.now()+1).toISOString());
 assert.throws(()=>embeddingConnection(f.store,f.policy),/remote_not_allowed/);
 f.store.updateMemorySemanticPolicy({...f.policy,expectedRevision:1,allowRemote:true});
 const sent=[];const provider={schemaVersion:1,upsert:async()=>{},remove:async()=>{},search:async()=>[],close(){},status(){return 'ready';}};
 const service=new MemorySemanticService({store:f.store,secretResolver,open:async()=>provider,embed:async({texts})=>{sent.push(...texts);return texts.map(()=>[1,0,0]);}});
 t.after(async()=>{service.beginShutdown();await service.drain();});
 const create=(id,extra)=>f.store.createMemoryObject({id,scopeType:'channel',ownerId:f.channel.id,title:id,body:'sensitive sentinel',...extra},f.now);
 create('normal',{});create('private',{sensitivity:'private'});create('owner-private',{scopeType:'teammate',ownerId:'private-owner'});
 await service.refresh();assert.equal(sent.length,1);assert.match(sent[0],/^normal/);
 await service.search({intent:'private-chat',query:'private-query-sentinel',teammateId:'private-owner'});assert.equal(sent.length,1);
 f.store.updateProviderPreset(f.preset.id,{enabled:false},new Date(Date.now()+2).toISOString());
 assert.equal(service.status().status,'unavailable');assert.deepEqual(await service.search({intent:'search',query:'hello'}),[]);
});
test('failed batch retains scan cursor and retries do not rebuild completed pages or override off',async t=>{
 const f=await setup(t,()=>{});let calls=0;
 for(let i=0;i<40;i++)f.store.createMemoryObject({id:`m${String(i).padStart(3,'0')}`,scopeType:'channel',ownerId:f.channel.id,title:'receipt',body:'body'},f.now);
 const provider={schemaVersion:1,upsert:async()=>{},remove:async()=>{},search:async()=>[],close(){},status(){return 'ready';}};
 const service=new MemorySemanticService({store:f.store,secretResolver,open:async()=>provider,embed:async({texts})=>{calls++;if(calls===2)throw Error('upstream');return texts.map(()=>[1,0,0]);}});
 t.after(async()=>{service.beginShutdown();await service.drain();});
 await service.refresh();const generation=f.store.getMemorySemanticGeneration();assert.equal(generation.scanAfter,'m031');
 await service.refresh();assert.equal(calls,2,'backoff prevents repeated paid requests');
 // A restarted service resumes the persisted scan page instead of re-embedding all 40 records.
 service.beginShutdown();await service.drain();
 const resumed=new MemorySemanticService({store:f.store,secretResolver,open:async()=>provider,embed:async({texts})=>{assert.equal(texts.length,8);return texts.map(()=>[1,0,0]);}});
 t.after(async()=>{resumed.beginShutdown();await resumed.drain();});await resumed.refresh();assert.equal(resumed.status().status,'ready');
 assert.equal(f.store.getMemorySemanticGeneration().generation,generation.generation);
 f.store.updateMemorySemanticPolicy({mode:'off',expectedRevision:1});await resumed.refresh();assert.equal(resumed.status().status,'not_configured');
});
