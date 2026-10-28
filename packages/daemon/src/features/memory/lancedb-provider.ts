import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MemoryVectorChunkV1, MemoryVectorHitV1, MemoryVectorProviderV1 } from '@ling-stack/plugin-sdk';

// Kept behind a dynamic import: native optional dependencies never participate in daemon startup.
// The structural boundary pins only the LanceDB 0.40 public methods exercised by native tests.
interface NativeQuery {
 where(sql:string):NativeQuery; limit(count:number):NativeQuery;
 distanceType(type:string):NativeQuery;
 toArray():Promise<Record<string,unknown>[]>;
}
interface NativeTable {
 delete(sql:string):Promise<unknown>;
 mergeInsert(key:string):{whenMatchedUpdateAll():{whenNotMatchedInsertAll():{execute(rows:Record<string,unknown>[]):Promise<unknown>}}};
 vectorSearch(vector:number[]):NativeQuery;
 close():void;
}
interface NativeConnection {
 openTable(name:string):Promise<NativeTable>;
 createTable(name:string,rows:Record<string,unknown>[]):Promise<NativeTable>;
 close():void;
}
export interface LanceDbModule { connect(path:string):Promise<NativeConnection> }
export async function loadLanceDb():Promise<LanceDbModule> {
 const configured=process.env.LING_MEMORY_LANCEDB_MODULE;
 if(configured){
  if(!isAbsolute(configured))throw new Error('memory_vector_module_path_invalid');
  return await import(pathToFileURL(createRequire(import.meta.url).resolve(configured)).href) as LanceDbModule;
 }
 const packageName='@lancedb/lancedb';
 return await import(packageName) as LanceDbModule;
}
const literal=(value:string):string=>`'${value.replaceAll("'","''")}'`;
export async function openLanceMemoryProvider(input:{readonly path:string;readonly tableName:string;
 readonly dimensions:number;readonly create:boolean;readonly load?:()=>Promise<LanceDbModule>}):Promise<MemoryVectorProviderV1> {
 if(!/^memory_[a-f0-9_]+$/.test(input.tableName)) throw new Error('memory_vector_table_invalid');
 const module=await (input.load??loadLanceDb)();
 const connection=await module.connect(input.path);
 let table:NativeTable;
 try {
  if(input.create){
   const id=`empty_${randomUUID()}`;
   table=await connection.createTable(input.tableName,[{memoryId:id,scopeKey:'',contentHash:'',qualificationRevision:0,validUntil:0,vector:Array(input.dimensions).fill(0)}]);
   await table.delete(`memoryId=${literal(id)}`);
  } else table=await connection.openTable(input.tableName);
 } catch(error){connection.close();throw error;}
 let closed=false;
 return {schemaVersion:1,
  async upsert(chunks){if(chunks.length) await table.mergeInsert('memoryId').whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(chunks.map(c=>({...c,vector:[...c.vector]})));},
  async remove(ids){if(ids.length) await table.delete(`memoryId IN (${ids.map(literal).join(',')})`);},
  async search(query){
   if(!query.scopeKeys.length) return [];
   const rows=await table.vectorSearch([...query.vector]).distanceType('cosine')
    .where(`scopeKey IN (${query.scopeKeys.map(literal).join(',')}) AND validUntil > ${query.now}`)
    .limit(query.maxResults).toArray();
   return rows.filter(row=>typeof row._distance==='number' && Number.isFinite(row._distance) && row._distance<=query.maxDistance)
    .map(row=>({memoryId:String(row.memoryId),scopeKey:String(row.scopeKey),contentHash:String(row.contentHash),qualificationRevision:Number(row.qualificationRevision)} satisfies MemoryVectorHitV1));
  },
  status(){return closed?'unavailable':'ready';},
  close(){if(!closed){closed=true;table.close();connection.close();}},
 };
}
