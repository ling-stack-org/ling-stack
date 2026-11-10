import type { RunStore, SecretResolver, MemorySemanticPolicy } from '@ling-stack/core';
import { fetchProvider } from '@ling-stack/runner-pi';
import { materializeProviderSecrets } from '../providers/secret-materializer.js';
import { isRecord } from '../../shared/validation.js';

export function embeddingConnection(store:RunStore,policy:MemorySemanticPolicy):{readonly local:boolean;readonly url:string;readonly providerId:string;readonly providerRevision:string} {
 const preset=policy.providerPresetId?store.getProviderPreset(policy.providerPresetId):undefined;
 if(!preset?.enabled || !preset.baseUrl || preset.api!=='openai-completions') throw new Error('memory_embedding_provider_unavailable');
 const endpoint=new URL(`${preset.baseUrl.replace(/\/$/,'')}/embeddings`);
 if(!['https:','http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('memory_embedding_endpoint_invalid');
 const local=['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
 if(!local && policy.allowRemote!==true) throw new Error('memory_embedding_remote_not_allowed');
 return {local,url:endpoint.href,providerId:preset.providerId,providerRevision:preset.updatedAt};
}
/** User-selected provider and explicit data policy; one bounded HTTP call, no tools or hidden retries. */
export async function embedMemoryText(input:{readonly store:RunStore;readonly policy:MemorySemanticPolicy;
 readonly secretResolver:SecretResolver;readonly texts:readonly string[];readonly signal:AbortSignal}):Promise<readonly (readonly number[])[]> {
 const {store,policy,signal,texts}=input;
 const connection=embeddingConnection(store,policy);
 const preset=store.getProviderPreset(policy.providerPresetId!)!;
 const materialized=materializeProviderSecrets({store,preset,secretResolver:input.secretResolver});
 const headers=new Headers(materialized.headers);headers.set('content-type','application/json');
 if(preset.authHeader!==false && materialized.apiKeySecret.value) headers.set('authorization',`Bearer ${materialized.apiKeySecret.value}`);
 if(texts.length<1||texts.length>32||texts.some(text=>Buffer.byteLength(text)>32768)) throw new Error('memory_embedding_input_over_budget');
 const response=await fetchProvider(connection.url,{method:'POST',redirect:'error',headers,signal,
  body:JSON.stringify({model:policy.model,dimensions:policy.dimensions,input:texts,encoding_format:'float'})});
 if(!response.ok){await response.body?.cancel();throw new Error('memory_embedding_request_failed');}
 const reader=response.body?.getReader();if(!reader) throw new Error('memory_embedding_output_invalid');
 const chunks:Uint8Array[]=[];let length=0;
 try {while(true){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;
  if(length>8*1024*1024) throw new Error('memory_embedding_output_over_budget');chunks.push(next.value);}}
 finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!isRecord(value)||!Array.isArray(value.data)||value.data.length!==texts.length)throw new Error('memory_embedding_output_invalid');
 const vectors:(readonly number[])[]=Array(texts.length);
 for(const item of value.data){
  if(!isRecord(item)||!Number.isSafeInteger(item.index)||Number(item.index)<0||Number(item.index)>=texts.length||vectors[Number(item.index)] ||
   !Array.isArray(item.embedding)||item.embedding.length!==policy.dimensions||item.embedding.some(x=>typeof x!=='number'||!Number.isFinite(x)) ||
   !item.embedding.some(x=>x!==0))throw new Error('memory_embedding_output_invalid');
  vectors[Number(item.index)]=item.embedding as number[];
 }
 signal.throwIfAborted();
 if(store.getProviderPreset(preset.id)?.updatedAt!==connection.providerRevision || !store.getProviderPreset(preset.id)?.enabled)throw new Error('memory_embedding_provider_changed');
 return vectors;
}
