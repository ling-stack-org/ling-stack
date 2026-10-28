import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_WORKSPACE_ID, type RunStore, type SecretResolver, type MemoryDerivativeSource,
 type MemorySemanticGeneration, type MemorySemanticPolicy, type MemoryRecallRequest, type RecalledMemory } from '@ling-stack/core';
import type { MemorySemanticStatus } from '@ling-stack/contracts';
import type { MemoryVectorProviderV1 } from '@ling-stack/plugin-sdk';
import { embeddingConnection, embedMemoryText } from './embedding-client.js';
import { openLanceMemoryProvider } from './lancedb-provider.js';

export const memoryScopeKey=(workspaceId:string,scopeType:string,ownerId:string):string=>JSON.stringify([workspaceId,scopeType,ownerId]);
export function memorySourceHash(source:MemoryDerivativeSource):string {
 const m=source.memory;
 return createHash('sha256').update(JSON.stringify([m.id,m.workspaceId,m.scopeType,m.ownerId,m.title,m.body,m.tags,m.sourceRefs,
  m.sensitivity,m.verifyBeforeUse,source.health?.validUntil,source.health?.supersededBy])).digest('hex');
}
const textFor=(s:MemoryDerivativeSource):string=>`${s.memory.title}\n${s.memory.tags.join(' ')}\n${s.memory.body}`.slice(0,4096);
export function semanticScopeKeys(input:MemoryRecallRequest):string[]{
 const workspaceId=input.workspaceId??DEFAULT_WORKSPACE_ID;
 return [['workspace',workspaceId],['channel',input.channelId],['teammate',input.teammateId],['task',input.taskId],['run',input.runId]]
  .filter((pair):pair is [string,string]=>Boolean(pair[1])).map(([scope,owner])=>memoryScopeKey(workspaceId,scope,owner));
}
interface SemanticServiceOptions {
 readonly store:RunStore; readonly secretResolver:SecretResolver;
 readonly open?:typeof openLanceMemoryProvider;
 readonly embed?:typeof embedMemoryText;
}
/** One background writer per workspace. Publication/checkpoints are fenced by SQLite generation and policy CAS. */
export class MemorySemanticService {
 private provider?:{readonly generation:MemorySemanticGeneration;readonly value:MemoryVectorProviderV1};
 private readonly retired:MemoryVectorProviderV1[]=[];
 private running?:Promise<void>;
 private readonly controllers=new Set<AbortController>();
 private readonly queries=new Set<Promise<unknown>>();
 private timer?:ReturnType<typeof setInterval>;
 private stopped=false;
 private retryAt=0;
 private failures=0;
 private failedPolicyRevision=-1;
 private state:MemorySemanticStatus={status:'not_configured',optional:true};
 constructor(private readonly options:SemanticServiceOptions){}
 start():void{if(this.timer||this.stopped)return;this.timer=setInterval(()=>void this.refresh(),5000);this.timer.unref();void this.refresh();}
 status():MemorySemanticStatus{
  const policy=this.options.store.getMemorySemanticPolicy();
  if(policy.mode==='off')return {status:'not_configured',optional:true};
  try{const identity=this.identity(policy);
   if(this.state.status==='not_configured'||(this.state.identity && this.state.identity!==identity)||
    (this.provider && this.provider.generation.policyRevision!==policy.revision))return {status:'rebuilding',optional:true,identity};
  }catch{return {status:'unavailable',optional:true,reason:'memory_embedding_configuration_unavailable'};}
  return this.state;
 }
 refresh():Promise<void>{
  if(this.stopped||(Date.now()<this.retryAt&&this.failedPolicyRevision===this.options.store.getMemorySemanticPolicy().revision))return Promise.resolve();
  if(this.running)return this.running;
  const work=Promise.resolve().then(()=>this.synchronize()).catch(()=>{this.state={status:'degraded',optional:true,reason:'memory_semantic_index_unavailable'};})
   .finally(()=>{if(this.running===work)this.running=undefined;
    if(this.queries.size===0){for(const p of this.retired)p.close();this.retired.length=0;}});
  this.running=work;return work;
 }
 revalidate(input:MemoryRecallRequest,matches:readonly RecalledMemory[]):readonly RecalledMemory[]{
  const scopes=semanticScopeKeys(input);
  const eligible=new Set(this.options.store.getEligibleMemoryIdsForRecall(input,matches.map(item=>item.memory.id)));
  return matches.filter(item=>{
   if(!eligible.has(item.memory.id)||!scopes.includes(memoryScopeKey(item.memory.workspaceId,item.memory.scopeType,item.memory.ownerId)))return false;
   const source=this.options.store.getMemoryDerivativeSource(item.memory.id);
   return source && memorySourceHash({...source,memory:item.memory})===memorySourceHash(source);
  });
 }
 async search(input:MemoryRecallRequest):Promise<readonly RecalledMemory[]>{
  const policy=this.options.store.getMemorySemanticPolicy();
  if(this.stopped||policy.mode==='off'||!input.query.trim()||input.query.trim().length<2)return [];
  const pending=this.searchCurrent(input,policy);
  this.queries.add(pending);
  try{return await pending;}finally{this.queries.delete(pending);}
 }
 private async searchCurrent(input:MemoryRecallRequest,policy:MemorySemanticPolicy):Promise<readonly RecalledMemory[]>{
  const controller=new AbortController();this.controllers.add(controller);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
   const identity=this.identity(policy);
   const held=this.provider, current=this.options.store.getMemorySemanticGeneration();
   if(!held || !current?.ready || held.generation.generation!==current.generation ||
    current.policyRevision!==policy.revision||current.identity!==identity)return [];
   if(!embeddingConnection(this.options.store,policy).local && input.intent==='private-chat' && !policy.allowPrivateRemote)return [];
   const job=(async()=>{
    const [vector]=await this.embed(policy,[input.query.slice(0,4096)],controller.signal);
    controller.signal.throwIfAborted();
    const scopes=semanticScopeKeys(input);
    const hits=await held.value.search({vector:vector!,scopeKeys:scopes,maxResults:20,maxDistance:policy.maxDistance!,now:Date.now()});
    controller.signal.throwIfAborted();
    if(!this.current(policy,current))return [];
    const ids=[...new Set(hits.map(h=>h.memoryId))].slice(0,20);
    const eligible=new Set(this.options.store.getEligibleMemoryIdsForRecall(input,ids));
    const matches:RecalledMemory[]=[];
    for(const hit of hits.slice(0,20)){
     if(!eligible.has(hit.memoryId)||!scopes.includes(hit.scopeKey))continue;
     const source=this.options.store.getMemoryDerivativeSource(hit.memoryId);
     if(!source||source.revision!==hit.qualificationRevision||memorySourceHash(source)!==hit.contentHash||
      memoryScopeKey(source.memory.workspaceId,source.memory.scopeType,source.memory.ownerId)!==hit.scopeKey)continue;
     if(!embeddingConnection(this.options.store,policy).local && (source.memory.sensitivity==='private'||source.memory.scopeType==='teammate')&&!policy.allowPrivateRemote)continue;
     matches.push({memory:source.memory,score:1/(60+matches.length+1),matchedTerms:[],excerpt:source.memory.body.slice(0,240)});
    }
    this.state={status:'ready',optional:true,identity};return matches;
   })();
   this.queries.add(job);
   void job.then(()=>this.queries.delete(job),()=>this.queries.delete(job));
   // Native queries cannot always abort. Race the entire operation and reject its late result.
   const deadline=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(new Error('memory_semantic_timeout'));},policy.timeoutMs??1000);});
   return await Promise.race([job,deadline]);
  }catch{this.state={status:'degraded',optional:true,reason:'memory_semantic_query_unavailable'};return [];}
  finally{if(timeout)clearTimeout(timeout);this.controllers.delete(controller);}
 }
 private identity(policy:MemorySemanticPolicy):string {
  const connection=embeddingConnection(this.options.store,policy);
  return createHash('sha256').update(JSON.stringify(['memory-vector-v1-clip4096',connection.providerId,connection.url,
   policy.model,policy.dimensions,policy.allowRemote,policy.allowPrivateRemote])).digest('hex');
 }
 private current(policy:MemorySemanticPolicy,generation:MemorySemanticGeneration):boolean {
  try{return !this.stopped && this.options.store.getMemorySemanticPolicy().revision===policy.revision &&
   this.options.store.getMemorySemanticGeneration()?.generation===generation.generation && this.identity(policy)===generation.identity;
  }catch{return false;}
 }
 private async synchronize():Promise<void>{
  const {store}=this.options;
  const policy=store.getMemorySemanticPolicy();
  if(policy.mode==='off'){
   if(this.provider){this.retired.push(this.provider.value);this.provider=undefined;}
   this.state={status:'not_configured',optional:true};return;
  }
  let identity:string;
  try{identity=this.identity(policy);}catch{this.state={status:'unavailable',optional:true,reason:'memory_embedding_configuration_unavailable'};return;}
  let generation=store.getMemorySemanticGeneration();
  const rebuild=!generation||generation.identity!==identity||generation.policyRevision!==policy.revision;
  try{
   if(rebuild){
    generation=store.beginMemorySemanticGeneration(policy.revision,identity,`memory_${identity.slice(0,16)}_${randomUUID().replaceAll('-','')}`);
    this.state={status:'rebuilding',optional:true,identity};
    const value=await (this.options.open??openLanceMemoryProvider)({path:join(store.paths.rootDir,'memory','lancedb'),
     tableName:generation.tableName,dimensions:policy.dimensions!,create:true});
    if(this.provider)this.retired.push(this.provider.value);this.provider={generation,value};
   } else if(!this.provider || this.provider.generation.generation!==generation!.generation){
    const value=await (this.options.open??openLanceMemoryProvider)({path:join(store.paths.rootDir,'memory','lancedb'),
     tableName:generation!.tableName,dimensions:policy.dimensions!,create:false});
    if(this.provider)this.retired.push(this.provider.value);this.provider={generation:generation!,value};
   }
   const value=this.provider!.value;
   // Persist each completed scan page. A transient failure resumes instead of paying to
   // embed the entire corpus again. Replayed last batches are idempotent upserts.
   if(!generation!.scanComplete){
    let after=generation!.scanAfter??'';
    while(this.current(policy,generation!)){
     const sources=store.listMemoryDerivativeSources(after,32);
     if(!sources.length){store.advanceMemorySemanticScan(generation!.generation,policy.revision,after,true);break;}
     await this.index(policy,generation!,value,sources);after=sources.at(-1)!.memory.id;
     if(!this.current(policy,generation!)||!store.advanceMemorySemanticScan(generation!.generation,policy.revision,after,false))return;
    }
    generation=store.getMemorySemanticGeneration()!;
   }
   while(this.current(policy,generation!)){
    const changes=store.listMemoryDerivativeChanges(generation!.checkpoint,32);
    if(!changes.length){
     if(store.advanceMemorySemanticGeneration(generation!.generation,policy.revision,generation!.checkpoint,true)){
      if(this.state.reason!=='memory_semantic_query_unavailable')this.state={status:'ready',optional:true,identity};
      this.failures=0;this.retryAt=0;
     }
     break;
    }
    const sources=changes.map(c=>store.getMemoryDerivativeSource(c.memoryId)).filter((s):s is MemoryDerivativeSource=>Boolean(s));
    await this.index(policy,generation!,value,sources);
    const ids=new Set(sources.map(s=>s.memory.id));await value.remove(changes.filter(c=>!ids.has(c.memoryId)).map(c=>c.memoryId));
    if(!this.current(policy,generation!)||!store.advanceMemorySemanticGeneration(generation!.generation,policy.revision,changes.at(-1)!.sequence,true))break;
    generation=store.getMemorySemanticGeneration()!;
   }
  } catch{
   if(generation && this.current(policy,generation))store.advanceMemorySemanticGeneration(generation.generation,policy.revision,generation.checkpoint,false);
   this.failures+=1;this.retryAt=Date.now()+Math.min(300_000,30_000*2**Math.min(this.failures-1,4));
   this.failedPolicyRevision=policy.revision;
   this.state={status:'unavailable',optional:true,identity,reason:'memory_semantic_index_unavailable'};
  }
 }
 private async index(policy:MemorySemanticPolicy,generation:MemorySemanticGeneration,provider:MemoryVectorProviderV1,sources:readonly MemoryDerivativeSource[]):Promise<void>{
  const local=embeddingConnection(this.options.store,policy).local;
  const allowed=sources.filter(s=>local||(s.memory.sensitivity!=='private'&&s.memory.scopeType!=='teammate')||policy.allowPrivateRemote);
  const excluded=sources.filter(s=>!allowed.includes(s)).map(s=>s.memory.id);
  if(excluded.length)await provider.remove(excluded);
  if(!allowed.length)return;
  const controller=new AbortController();this.controllers.add(controller);
  const timeout=setTimeout(()=>controller.abort(),30_000);
  try{
   const vectors=await this.embed(policy,allowed.map(textFor),controller.signal);
   controller.signal.throwIfAborted();
   if(!this.current(policy,generation))return;
   const chunks=allowed.flatMap((source,index)=>{
    const current=this.options.store.getMemoryDerivativeSource(source.memory.id);
    if(!current||current.revision!==source.revision||memorySourceHash(current)!==memorySourceHash(source))return [];
    return [{memoryId:source.memory.id,scopeKey:memoryScopeKey(source.memory.workspaceId,source.memory.scopeType,source.memory.ownerId),
     contentHash:memorySourceHash(source),qualificationRevision:source.revision,validUntil:source.health?.validUntil?Date.parse(source.health.validUntil):Number.MAX_SAFE_INTEGER,
     vector:vectors[index]!}];
   });
   await provider.upsert(chunks);
  }finally{clearTimeout(timeout);this.controllers.delete(controller);}
 }
 private embed(policy:MemorySemanticPolicy,texts:readonly string[],signal:AbortSignal){return (this.options.embed??embedMemoryText)({store:this.options.store,policy,
  secretResolver:this.options.secretResolver,texts,signal});}
 beginShutdown():void{this.stopped=true;if(this.timer)clearInterval(this.timer);for(const c of this.controllers)c.abort();}
 async drain():Promise<void>{await this.running;await Promise.allSettled([...this.queries]);this.provider?.value.close();for(const p of this.retired)p.close();this.retired.length=0;}
}
