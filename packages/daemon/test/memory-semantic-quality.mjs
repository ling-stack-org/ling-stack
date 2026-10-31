// Explicit, opt-in real-provider evaluation. Not part of the offline unit-test suite.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {join} from 'node:path';
import {learningFixture} from './support/learning-review-fixture.mjs';
import {embedMemoryText} from '../dist/features/memory/embedding-client.js';
import {MemorySemanticService} from '../dist/features/memory/semantic-service.js';
import {openLanceMemoryProvider} from '../dist/features/memory/lancedb-provider.js';
import {registerMemorySemanticService} from '../dist/features/memory/semantic-registry.js';
import {recallMemory} from '../dist/features/memory/recall-service.js';
const endpoint=process.env.LING_MEMORY_EVAL_URL, modulePath=process.env.LING_TEST_LANCEDB_MODULE;
assert.ok(endpoint&&modulePath,'Set LING_MEMORY_EVAL_URL and LING_TEST_LANCEDB_MODULE explicitly');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname),'This harness is restricted to a local real model');
const fixture=JSON.parse(await readFile(new URL('./fixtures/memory-semantic-quality.json',import.meta.url),'utf8'));
const cleanups=[], f=await learningFixture({after(fn){cleanups.push(fn);}}), secretResolver={resolve(){return {status:'not_required'};}};
let service;
try {
 const preset=f.store.createProviderPreset({kind:'openai-compatible',displayName:'Temporary real embedding evaluation',providerId:'local-eval',model:'ling-memory-eval',api:'openai-completions',
  baseUrl:endpoint,authHeader:false,reasoning:false,capabilities:['chat'],enabled:true},f.now);
 for(const d of fixture.documents)f.store.createMemoryObject({...d,scopeType:'channel',ownerId:f.channel.id,sourceRefs:[{type:'manual',id:`fixture:${d.id}`,label:'Authored evaluation fixture'}]},f.now);
 const configuration={expectedRevision:0,mode:'lancedb',providerPresetId:preset.id,model:'ling-memory-eval',dimensions:768,timeoutMs:1000,maxDistance:2};
 const probe={...configuration,revision:1};
 const embed=texts=>embedMemoryText({store:f.store,policy:probe,secretResolver,texts,signal:AbortSignal.timeout(30000)});
 const docVectors=await embed(fixture.documents.map(d=>`${d.title}\n${(d.tags??[]).join(' ')}\n${d.body}`));
 const calibration=await embed(fixture.calibration.map(q=>q.query));
 const cosine=(a,b)=>1-a.reduce((s,x,i)=>s+x*b[i],0)/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));
 const negativeDistances=fixture.calibration.flatMap((q,i)=>q.gold===null?[Math.min(...docVectors.map(v=>cosine(calibration[i],v)))]:[]);
 // Threshold uses calibration negatives only; evaluation questions remain held out.
 const threshold=Math.max(0,Math.min(...negativeDistances)-0.01);
 const policy=f.store.updateMemorySemanticPolicy({...configuration,maxDistance:threshold});
 const native=createRequire(import.meta.url)(modulePath);
 service=new MemorySemanticService({store:f.store,secretResolver,open:options=>openLanceMemoryProvider({...options,load:async()=>native})});
 registerMemorySemanticService(f.store,service);
 const buildStart=performance.now();await service.refresh();assert.equal(service.status().status,'ready');const indexMs=performance.now()-buildStart;
 const rows=[];
 for(const q of fixture.evaluation){
  const request={runId:f.run.id,intent:'task-run',query:q.query,maxResults:6};
  const local=f.store.recallMemory({...request,workspaceId:'workspace_default',channelId:f.channel.id,teammateId:'ling_agent',taskId:f.task.id});
  const started=performance.now();const fused=await recallMemory(f.store,request);const duration=performance.now()-started;
  rows.push({...q,local:local.memories.map(m=>m.memory.id),fused:fused.memories.map(m=>m.memory.id),durationMs:duration});
 }
 const metric=key=>{const positives=rows.filter(r=>r.gold),negatives=rows.filter(r=>!r.gold);return {
  recallAt6:positives.filter(r=>r[key].includes(r.gold)).length/positives.length,
  mrr:positives.reduce((sum,r)=>sum+(r[key].includes(r.gold)?1/(r[key].indexOf(r.gold)+1):0),0)/positives.length,
  unrelatedHitRate:negatives.filter(r=>r[key].length>0).length/negatives.length};};
 const lexical=metric('local'),semantic=metric('fused'),timings=rows.map(r=>r.durationMs).sort((a,b)=>a-b);
 const diskBytes=async path=>{let total=0;for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);total+=entry.isDirectory()?await diskBytes(p):(await stat(p)).size;}return total;};
 const result={model:'embeddinggemma-300m-qat-Q8_0',dimensions:768,documents:fixture.documents.length,calibrationQuestions:fixture.calibration.length,
  evaluationQuestions:rows.length,threshold,lexical,semantic,indexMs,p50Ms:timings[Math.floor(timings.length*0.5)],p95Ms:timings[Math.floor(timings.length*0.95)],
  indexBytes:await diskBytes(join(f.store.paths.rootDir,'memory','lancedb')),networkCost:0,scopeViolations:rows.flatMap(r=>r.fused).filter(id=>!fixture.documents.some(d=>d.id===id)).length,rows};
 await writeFile(process.env.LING_MEMORY_EVAL_OUTPUT??'memory-semantic-quality-result.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({...result,rows:undefined},null,2));
 assert.ok(semantic.recallAt6>lexical.recallAt6);assert.ok(semantic.mrr>lexical.mrr);assert.ok(semantic.unrelatedHitRate<=lexical.unrelatedHitRate);
 assert.ok(rows.find(r=>r.query==='TN001').fused[0]==='identifier');
 f.store.updateMemorySemanticPolicy({mode:'off',expectedRevision:policy.revision});
 assert.equal((await recallMemory(f.store,{runId:f.run.id,intent:'task-run',query:'TN001'})).memories[0].memory.id,'identifier');
 console.log('Quality/precision/exact-id/disabled-provider gates passed on this bounded authored fixture. No general quality claim.');
}finally{service?.beginShutdown();await service?.drain();for(const cleanup of cleanups.reverse())await cleanup();}
