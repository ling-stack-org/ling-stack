import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {openLanceMemoryProvider} from '../dist/features/memory/lancedb-provider.js';
const modulePath=process.env.LING_TEST_LANCEDB_MODULE;
test('real LanceDB: durable upsert/remove, quoted scopes, pre-top-k isolation and expiry',async t=>{
 if(!modulePath){t.skip('Optional LanceDB native module is not configured for this test');return;}
 const require=createRequire(import.meta.url);const load=async()=>require(modulePath);
 const path=await mkdtemp(join(tmpdir(),'ling-lance-'));t.after(()=>rm(path,{recursive:true,force:true}));
 let provider=await openLanceMemoryProvider({path,tableName:'memory_abcd',dimensions:3,create:true,load});
 t.after(()=>provider.close());
 const row=(memoryId,scopeKey,vector=[1,0,0],validUntil=Number.MAX_SAFE_INTEGER)=>({memoryId,scopeKey,contentHash:'hash',qualificationRevision:1,vector,validUntil});
 await provider.upsert([row('mine',"owner's-private",[0.9,0.1,0]),row('foreign','foreign'),row('expired',"owner's-private",[1,0,0],1)]);
 const query={vector:[1,0,0],scopeKeys:["owner's-private"],maxResults:1,maxDistance:0.1,now:Date.now()};
 assert.deepEqual((await provider.search(query)).map(x=>x.memoryId),['mine'],'closer foreign and expired rows cannot crowd the authorized hit out');
 await provider.upsert([row('mine',"owner's-private",[0,1,0])]);
 assert.deepEqual(await provider.search(query),[],'cosine threshold excludes unrelated result');
 provider.close();provider=await openLanceMemoryProvider({path,tableName:'memory_abcd',dimensions:3,create:false,load});
 assert.deepEqual((await provider.search({...query,vector:[0,1,0]})).map(x=>x.memoryId),['mine']);
 await provider.remove(['mine']);assert.deepEqual(await provider.search({...query,vector:[0,1,0]}),[]);
});
