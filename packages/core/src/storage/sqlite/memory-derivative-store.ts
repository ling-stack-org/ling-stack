import type { SQLOutputValue } from 'node:sqlite';
import type { MemoryDerivativeSource, MemoryDerivativeStore, MemorySemanticGeneration, MemorySemanticPolicy, MemorySemanticPolicyUpdate } from '../../memory-derivative-types.js';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-types.js';
import { mapMemoryObject, mapMemorySelfImprovingMetadata } from './memory-mappers.js';
import { memoryObjectSelectSql, memorySelfImprovingMetadataSelectSql } from './select-sql.js';
import type { SqliteStoreContext } from './store-context.js';

// These derivatives never contain candidates, archived/disabled, expired, replaced or secret-adjacent knowledge.
const eligibility = `workspace_id = ? AND enabled = 1 AND review_state = 'active' AND sensitivity != 'secret-adjacent'
 AND NOT EXISTS(SELECT 1 FROM memory_self_improving_metadata h WHERE h.memory_id=memory_objects.id AND
 (h.superseded_by IS NOT NULL OR (h.valid_until IS NOT NULL AND
 (julianday(h.valid_until) IS NULL OR julianday(h.valid_until)<=julianday(?)))))`;

export class SqliteMemoryDerivativeStore implements MemoryDerivativeStore {
 constructor(private readonly context: SqliteStoreContext) {}
 getMemorySemanticPolicy(): MemorySemanticPolicy {
  return this.read<MemorySemanticPolicy>('memory_semantic_policy') ?? { revision:0, mode:'off' };
 }
 updateMemorySemanticPolicy(input: MemorySemanticPolicyUpdate): MemorySemanticPolicy {
  return this.transaction(()=>{
   const current=this.getMemorySemanticPolicy();
   if(current.revision!==input.expectedRevision) throw new Error('memory_semantic_policy_conflict');
   if(!['off','lancedb'].includes(input.mode) || (input.mode==='lancedb' &&
    (!input.providerPresetId?.trim() || !input.model?.trim() || input.model.length>200 ||
     !Number.isSafeInteger(input.dimensions) || input.dimensions!<1 || input.dimensions!>8192)) ||
    (input.mode==='lancedb' && (typeof input.maxDistance!=='number' || !Number.isFinite(input.maxDistance) || input.maxDistance<0 || input.maxDistance>2)) ||
    (input.timeoutMs!==undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs<1 || input.timeoutMs>1000)) ||
    (input.allowRemote!==undefined && typeof input.allowRemote!=='boolean') ||
    (input.allowPrivateRemote!==undefined && typeof input.allowPrivateRemote!=='boolean')) throw new Error('memory_semantic_policy_invalid');
   const next: MemorySemanticPolicy={revision:current.revision+1,mode:input.mode,providerPresetId:input.providerPresetId,
    model:input.model,dimensions:input.dimensions,timeoutMs:input.timeoutMs??1000,
    allowRemote:input.allowRemote===true,allowPrivateRemote:input.allowPrivateRemote===true,maxDistance:input.maxDistance};
   this.write('memory_semantic_policy',next); return next;
  });
 }
 listMemoryDerivativeSources(afterId='',limit=64): MemoryDerivativeSource[] {
  if(!Number.isSafeInteger(limit)||limit<1||limit>256) throw new Error('memory_derivative_limit_invalid');
  return this.transaction(()=>this.context.database.prepare(memoryObjectSelectSql(`WHERE ${eligibility} AND id>? ORDER BY id LIMIT ?`))
   .all(DEFAULT_WORKSPACE_ID,new Date().toISOString(),afterId,limit).map(row=>this.source(row)));
 }
 getMemoryDerivativeSource(id: string): MemoryDerivativeSource | undefined {
  return this.transaction(()=>{const row=this.context.database.prepare(memoryObjectSelectSql(`WHERE ${eligibility} AND id=?`))
   .get(DEFAULT_WORKSPACE_ID,new Date().toISOString(),id);
  return row ? this.source(row) : undefined;});
 }
 listMemoryDerivativeChanges(afterSequence: number,limit=64): readonly {sequence:number; memoryId:string}[] {
  if(!Number.isSafeInteger(afterSequence)||afterSequence<0||!Number.isSafeInteger(limit)||limit<1||limit>256) throw new Error('memory_derivative_limit_invalid');
  return this.context.database.prepare('SELECT sequence,memory_id FROM memory_derivative_outbox WHERE sequence>? ORDER BY sequence LIMIT ?')
   .all(afterSequence,limit).map(row=>({sequence:Number(row.sequence),memoryId:String(row.memory_id)}));
 }
 getMemoryDerivativeSequence(): number {
  return Number(this.context.database.prepare("SELECT seq FROM sqlite_sequence WHERE name='memory_derivative_outbox'").get()?.seq??0);
 }
 getMemorySemanticGeneration(): MemorySemanticGeneration | undefined { return this.read('memory_semantic_generation'); }
 beginMemorySemanticGeneration(policyRevision:number,identity:string,tableName:string): MemorySemanticGeneration {
  return this.transaction(()=>{
   if(this.getMemorySemanticPolicy().revision!==policyRevision) throw new Error('memory_semantic_policy_conflict');
   const current=this.getMemorySemanticGeneration();
   const next={generation:(current?.generation??0)+1,policyRevision,identity,tableName,checkpoint:this.getMemoryDerivativeSequence(),ready:false,scanAfter:'',scanComplete:false};
   this.write('memory_semantic_generation',next); return next;
  });
 }
 advanceMemorySemanticScan(generation:number,policyRevision:number,afterId:string,complete:boolean):boolean {
  return this.transaction(()=>{
   const current=this.getMemorySemanticGeneration();
   if(!current||current.generation!==generation||current.policyRevision!==policyRevision||
    this.getMemorySemanticPolicy().revision!==policyRevision||afterId<(current.scanAfter??''))return false;
   this.write('memory_semantic_generation',{...current,scanAfter:afterId,scanComplete:complete});return true;
  });
 }
 advanceMemorySemanticGeneration(generation:number,policyRevision:number,checkpoint:number,ready:boolean): boolean {
  return this.transaction(()=>{
   const current=this.getMemorySemanticGeneration();
   if(!current || current.generation!==generation || current.policyRevision!==policyRevision ||
    this.getMemorySemanticPolicy().revision!==policyRevision || !Number.isSafeInteger(checkpoint) ||
    checkpoint<current.checkpoint || checkpoint>this.getMemoryDerivativeSequence()) return false;
   this.write('memory_semantic_generation',{...current,checkpoint,ready});
   if(ready) this.context.database.prepare('DELETE FROM memory_derivative_outbox WHERE sequence<=?').run(checkpoint);
   return true;
  });
 }
 private source(row: Record<string,SQLOutputValue>): MemoryDerivativeSource {
  const memory=mapMemoryObject(row);
  const rowVersion=this.context.database.prepare('SELECT revision,content_updated_at FROM memory_derivative_revisions WHERE memory_id=?').get(memory.id);
  const revision=Number(rowVersion?.revision??0);
  const health=this.context.database.prepare(memorySelfImprovingMetadataSelectSql('WHERE memory_id=?')).get(memory.id);
  return {memory,revision,contentUpdatedAt:rowVersion?String(rowVersion.content_updated_at):undefined,health:health?mapMemorySelfImprovingMetadata(health):undefined};
 }
 private read<T>(table:'memory_semantic_policy'|'memory_semantic_generation'): T|undefined {
  const row=this.context.database.prepare(`SELECT record_json FROM ${table} WHERE id=1`).get();
  return row?JSON.parse(String(row.record_json)) as T:undefined;
 }
 private write(table:'memory_semantic_policy'|'memory_semantic_generation',value:unknown):void {
  this.context.database.prepare(`INSERT INTO ${table} VALUES(1,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json`).run(JSON.stringify(value));
 }
 private transaction<T>(action:()=>T):T {
  this.context.database.exec('SAVEPOINT memory_derivative_write');
  try {const result=action();this.context.database.exec('RELEASE memory_derivative_write');return result;}
  catch(error){this.context.database.exec('ROLLBACK TO memory_derivative_write; RELEASE memory_derivative_write');throw error;}
 }
}
