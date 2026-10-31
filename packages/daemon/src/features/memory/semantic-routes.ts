import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunStore } from '@ling-stack/core';
import type { MemorySemanticPolicyUpdate } from '@ling-stack/contracts';
import type { ResolvedDaemonConfig } from '../../config.js';
import { readJsonBody } from '../../shared/request.js';
import { writeJson } from '../../shared/response.js';
import { isRecord } from '../../shared/validation.js';
import { embeddingConnection } from './embedding-client.js';
import { getMemorySemanticService } from './semantic-registry.js';
export async function handleMemorySemanticRoute(input:{readonly request:IncomingMessage;readonly response:ServerResponse;
 readonly url:URL;readonly config:ResolvedDaemonConfig;readonly getStore:(cwd:string)=>RunStore}):Promise<void>{
 const {request,response,url}=input;
 const cwd=url.searchParams.get('cwd');if(!cwd){writeJson(response,400,{error:'cwd_required'});return;}
 try{
  const store=input.getStore(cwd);const service=getMemorySemanticService(store);
  if(request.method==='PUT'){
   const body=await readJsonBody(request,input.config.maxBodyBytes);
   if(!isRecord(body)||!Number.isSafeInteger(body.expectedRevision)||!['off','lancedb'].includes(String(body.mode)))throw new Error('memory_semantic_policy_invalid');
   const proposed=body as unknown as MemorySemanticPolicyUpdate;
   if(proposed.mode==='lancedb')embeddingConnection(store,{...proposed,revision:proposed.expectedRevision+1});
   store.updateMemorySemanticPolicy(proposed);
   void service?.refresh();
  }else if(request.method!=='GET'){writeJson(response,405,{error:'method_not_allowed'});return;}
  writeJson(response,200,{cwd,policy:store.getMemorySemanticPolicy(),status:service?.status()??{status:'not_configured',optional:true}});
 }catch(error){const code=error instanceof Error && /^memory_[a-z_]+$/.test(error.message)?error.message:'memory_semantic_request_failed';
  writeJson(response,code.endsWith('conflict')?409:400,{error:code});}
}
