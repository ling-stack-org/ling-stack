import { isDeepStrictEqual } from "node:util";
import type { RunStore } from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import type { RunRequest } from "../runs/schemas.js";
import { assertInlineProviderCredentialsAvailable } from "../runs/provider-persistence.js";

/** Provider credentials remain at their existing source, never in preparation evidence. */
export function inlineProviderDescriptor(provider: PiRunnerProviderConfig): Omit<PiRunnerProviderConfig, "apiKey" | "headers"> {
  const { apiKey: _credential, headers: _headers, ...descriptor } = provider;
  return descriptor;
}

/** Inheritance needs a same-thread parent, or the exact Run in a validated frozen fork seed. */
export function restorePreparedInlineProvider(store: RunStore, request: RunRequest, sourceRunId: string): PiRunnerProviderConfig {
  const source = store.getRun(sourceRunId);
  const owner = source ? store.getLingTurnForRun(source.id) : undefined;
  const fork = source && request.threadId && source.threadId !== request.threadId ? store.getNormalConversationForkSeed(request.threadId) : undefined;
  const expectedThreadId = fork?.threadId ?? request.threadId;
  if (!source || sourceRunId !== request.parentRunId || source.threadId !== expectedThreadId ||
    !owner || owner.threadId !== expectedThreadId || source.channelId || owner.channelId || source.workflowStepId ||
    (fork && (fork.sourceRunId !== sourceRunId || fork.turnId !== owner.id || fork.sourceItemId !== owner.sourceItemId))) {
    throw new Error("Prepared inline provider source scope mismatch");
  }
  const snapshot = isRecord(source.requestSnapshot) ? source.requestSnapshot : {};
  if (source.providerPresetId || snapshot.providerPresetId) throw new Error("Prepared inline provider source changed to a preset");
  const value = isRecord(snapshot.provider) ? snapshot.provider : source.providerSnapshot;
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    throw new Error("Prepared inline provider source is missing");
  }
  const { providerPresetId: _preset, ...provider } = value;
  const current = provider as unknown as PiRunnerProviderConfig;
  if (!isDeepStrictEqual(inlineProviderDescriptor(current), request.provider)) {
    throw new Error("Prepared inline provider configuration changed");
  }
  assertInlineProviderCredentialsAvailable(current);
  return { ...request.provider!, ...(current.apiKey !== undefined ? { apiKey: current.apiKey } : {}),
    ...(current.headers !== undefined ? { headers: { ...current.headers } } : {}) };
}
