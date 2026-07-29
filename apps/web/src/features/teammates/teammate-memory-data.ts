import {
  getMemoryHealth,
  getMemoryReviewPolicy,
  listMemoryObjects,
  listMemoryPromotionInbox,
  listTeammateMemoryScopes,
  listUsedMemoryEvents,
} from "../../api.js";
import type { TeammateMemorySnapshot } from "./teammate-memory-view-models.js";

export async function loadTeammateMemorySnapshot(
  cwd: string,
  teammateId: string,
): Promise<TeammateMemorySnapshot> {
  const [scopeResponse, memoryResponse, healthResponse, policyResponse, inboxResponse, usedResponse] = await Promise.all([
    listTeammateMemoryScopes(cwd, teammateId),
    listMemoryObjects(cwd),
    getMemoryHealth(cwd, { limit: 100 }),
    getMemoryReviewPolicy(cwd),
    listMemoryPromotionInbox(cwd, { limit: 100 }),
    listUsedMemoryEvents(cwd, { teammateId, limit: 100 }),
  ]);
  return {
    scopes: scopeResponse.scopes,
    memories: memoryResponse.memories,
    health: healthResponse.report,
    policy: policyResponse.policy,
    inbox: inboxResponse.items,
    usedEvents: usedResponse.events,
    vectorRetrieval: memoryResponse.vectorRetrieval,
  };
}
