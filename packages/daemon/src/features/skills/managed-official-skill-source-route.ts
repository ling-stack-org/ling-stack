import type { IncomingMessage, ServerResponse } from "node:http";
import "../../runtime/sandbox/core-original-process-bridge.js";
import {
  OFFICIAL_GSTACK_ORIGIN_URL,
  OFFICIAL_GSTACK_REF,
  OFFICIAL_GSTACK_SOURCE_ID,
  ManagedOfficialSkillSourceError,
  officialGstackSourceScanRoot,
  refreshManagedOfficialGstackSource,
  resolveStoragePaths,
  type ManagedOfficialSkillSource,
  type OfficialSkillSourceSubscription,
  type SkillSourceScanRoot,
  type UpsertOfficialSkillSourceSubscriptionInput,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { writeJson } from "../../shared/response.js";

interface OfficialSkillSourceStore {
  getOfficialSkillSourceSubscription(): OfficialSkillSourceSubscription | undefined;
  upsertOfficialSkillSourceSubscription(
    input: UpsertOfficialSkillSourceSubscriptionInput,
    now: string,
  ): OfficialSkillSourceSubscription;
}

interface ManagedOfficialSkillSourceRouteInput {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly cwd: string;
  readonly store: unknown;
}

export async function handleManagedOfficialSkillSourceRoute(input: ManagedOfficialSkillSourceRouteInput): Promise<boolean> {
  if (input.url.pathname !== "/skills/sync/gstack/status") {
    return false;
  }
  if (input.request.method !== "GET") {
    writeJson(input.response, 405, { error: "method_not_allowed", message: `${input.request.method} is not supported for /skills/sync/gstack/status` });
    return true;
  }
  const subscription = requireOfficialSkillSourceStore(input.store).getOfficialSkillSourceSubscription();
  writeJson(input.response, 200, {
    cwd: input.cwd,
    status: subscription?.revision ? "synced" : "ready",
    source: publicSourceState(subscription),
  });
  return true;
}

export async function refreshManagedOfficialGstackSkillSource(cwd: string): Promise<{
  readonly source: ManagedOfficialSkillSource;
  readonly scanRoot: SkillSourceScanRoot;
}> {
  try {
    const source = await refreshManagedOfficialGstackSource({ sourcesDir: resolveStoragePaths(cwd).user.sourcesDir });
    return { source, scanRoot: officialGstackSourceScanRoot(source) };
  } catch (error) {
    if (error instanceof ManagedOfficialSkillSourceError) {
      throw new HttpError(503, "official_skill_source_unavailable", "Unable to update official skills. Check your connection and try again.");
    }
    throw error;
  }
}

export function saveManagedOfficialGstackSubscription(
  store: unknown,
  source: ManagedOfficialSkillSource,
  now: string,
): OfficialSkillSourceSubscription {
  return requireOfficialSkillSourceStore(store).upsertOfficialSkillSourceSubscription({
    sourceId: source.sourceId,
    originUrl: source.originUrl,
    ref: source.ref,
    revision: source.revision,
    version: source.version,
    lastSyncedAt: now,
  }, now);
}

export function publicSourceState(subscription: OfficialSkillSourceSubscription | undefined): Record<string, unknown> {
  return {
    sourceId: OFFICIAL_GSTACK_SOURCE_ID,
    originUrl: subscription?.originUrl ?? OFFICIAL_GSTACK_ORIGIN_URL,
    ref: subscription?.ref ?? OFFICIAL_GSTACK_REF,
    ...(subscription?.revision ? { revision: subscription.revision } : {}),
    ...(subscription?.version ? { version: subscription.version } : {}),
    ...(subscription?.lastSyncedAt ? { lastSyncedAt: subscription.lastSyncedAt } : {}),
  };
}

function requireOfficialSkillSourceStore(store: unknown): OfficialSkillSourceStore {
  const candidate = store as Partial<OfficialSkillSourceStore>;
  if (typeof candidate?.getOfficialSkillSourceSubscription !== "function" || typeof candidate.upsertOfficialSkillSourceSubscription !== "function") {
    throw new HttpError(500, "official_skill_source_store_unavailable", "The workspace store does not support official skill source subscriptions.");
  }
  return candidate as OfficialSkillSourceStore;
}
