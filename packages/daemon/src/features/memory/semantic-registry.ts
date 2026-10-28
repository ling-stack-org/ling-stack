import type { RunStore } from '@ling-stack/core';
import type { MemorySemanticService } from './semantic-service.js';
const services=new WeakMap<object,MemorySemanticService>();
export function registerMemorySemanticService(store:RunStore,service:MemorySemanticService):void{services.set(store,service);}
export function getMemorySemanticService(store:object):MemorySemanticService|undefined{return services.get(store);}
