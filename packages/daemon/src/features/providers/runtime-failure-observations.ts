import { randomUUID } from "node:crypto";
import type { AvailabilityIncident, AvailabilityIncidentCandidate, AvailabilityIncidentCandidateCursor,
  ProviderModelRuntimeObservation, ProviderRuntimeAvailabilityIncidentSource, RunStore, SecretResolver } from "@ling-stack/core";
import { readProviderInvocationFailure, type ProviderInvocationFailure, type ProviderInvocationFailureFact } from "./runtime-invocations.js";
import { compareProviderRuntimeObservationScope, providerRuntimeObservationScopesEquivalent, providerRuntimeScopeOwnedByStore,
  type ProviderRuntimeObservationScope } from "./runtime-observation-scope.js";

const CONTEXT_OBSERVATION_TTL_MS = 6 * 60 * 60 * 1_000;
const MIN_CONTEXT_WINDOW_TOKENS = 2_048;
const MAX_PRIVATE_OBSERVATIONS = 4_096;

interface ContextObservation {
  readonly scope: ProviderRuntimeObservationScope;
  readonly observation: ProviderModelRuntimeObservation;
}
interface IncidentObservation {
  readonly scope: ProviderRuntimeObservationScope;
  readonly source: ProviderRuntimeAvailabilityIncidentSource;
  readonly incidentId: string;
}
export interface ProviderInvocationFailureObservations {
  readonly incident?: AvailabilityIncident;
  readonly contextObservation?: ProviderModelRuntimeObservation;
}
interface StoreObservations {
  readonly context: Map<string, ContextObservation>;
  readonly incidents: Map<string, IncidentObservation>;
  readonly recorded: WeakMap<ProviderInvocationFailure, ProviderInvocationFailureObservations>;
}
const observations = new WeakMap<RunStore, StoreObservations>();

/**
 * Publish original safe lineage atomically. A late fact remains historical, but
 * only a current scope can update a context budget. No preset reread attributes
 * an old failure to a new model, and no serialized DTO acquires private proof.
 */
export function recordProviderInvocationFailureObservations(input: {
  readonly store: RunStore;
  readonly secretResolver: SecretResolver;
  readonly failure: ProviderInvocationFailure;
  readonly agentId?: string;
  readonly now?: string;
}): ProviderInvocationFailureObservations {
  const fact = readProviderInvocationFailure(input.failure);
  const now = currentTime(input.now);
  if (!fact || !now || !providerRuntimeScopeOwnedByStore(input.store, fact.scope)) return {};
  const state = storeObservations(input.store);
  const recorded = state.recorded.get(input.failure);
  if (recorded) return recorded;
  const source = originalSource(fact);
  let incident: AvailabilityIncident;
  try {
    incident = input.store.createProviderRuntimeAvailabilityIncident({
      incident: {
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        providerPresetId: fact.identity.providerPresetId,
        modelSignature: { providerPresetId: fact.identity.providerPresetId, model: fact.identity.modelId, api: fact.identity.providerApi },
        state: fact.classification.state, kind: fact.classification.kind, severity: fact.classification.severity,
        summary: `${fact.classification.label} observed for ${fact.identity.providerPresetId} (${fact.identity.modelId}).`,
        observedAt: fact.settledAt,
        expiresAt: new Date(Date.parse(fact.settledAt) + fact.classification.ttlMs).toISOString(),
      }, source,
    }, now.iso);
  } catch {
    // A publication failure is diagnostic unknown, not a model-call failure.
    // Do not mark it recorded: a later retry may publish the atomic pair.
    return {};
  }
  state.incidents.set(source.observationId, { scope: fact.scope, source, incidentId: incident.id });
  trimOldest(state.incidents);
  expireContextObservations(state, now.ms);
  const contextObservation = learnContextObservation(input, state, fact, now.ms);
  const result = Object.freeze({ incident, ...(contextObservation ? { contextObservation } : {}) });
  state.recorded.set(input.failure, result);
  return result;
}

/** Return only a live same-authority window; historical cache data remains private. */
export function providerRuntimeContextObservationForPreset(input: {
  readonly store: RunStore;
  readonly secretResolver?: SecretResolver;
  readonly providerPresetId?: string;
  /** Live Attempt authority, never reconstructed from public Run data. */
  readonly expectedScope?: ProviderRuntimeObservationScope;
  readonly now?: string;
}): ProviderModelRuntimeObservation | undefined {
  const state = observations.get(input.store);
  const now = currentTime(input.now);
  if (!state || !now || !input.providerPresetId) return undefined;
  expireContextObservations(state, now.ms);
  const cached = state.context.get(input.providerPresetId);
  if (cached && input.expectedScope !== undefined && (!providerRuntimeScopeOwnedByStore(input.store, input.expectedScope)
    || !providerRuntimeObservationScopesEquivalent(cached.scope, input.expectedScope))) return undefined;
  return cached && now.ms >= Date.parse(cached.observation.observedAt)
    && scopeCurrentlyMatches(input, cached.scope) ? cached.observation : undefined;
}

/**
 * Scope filtering precedes accepted limits. Core owns stable keyset pages;
 * the Host continues past any number of historical/unknown candidates.
 */
export function listCurrentlyApplicableAvailabilityIncidents(input: {
  readonly store: RunStore;
  readonly secretResolver?: SecretResolver;
  readonly now: string;
  readonly agentId?: string;
  readonly providerPresetId?: string;
  /** Only runtime facts use this target: absent is global, null means no effective Provider. */
  readonly applicableProviderPresetId?: string | null;
  readonly limit?: number;
}): AvailabilityIncident[] {
  const now = currentTime(input.now);
  const limit = input.limit ?? 100;
  if (!now || !Number.isSafeInteger(limit) || limit < 1) return [];
  const result: AvailabilityIncident[] = [];
  const state = observations.get(input.store);
  let cursor: AvailabilityIncidentCandidateCursor | undefined;
  do {
    let page;
    try {
      page = input.store.listAvailabilityIncidentCandidates({ now: now.iso,
        agentId: input.agentId, providerPresetId: input.providerPresetId,
        pageSize: 500, ...(cursor ? { cursor } : {}) });
    } catch {
      // A partial read is not a trustworthy current-health snapshot.
      return [];
    }
    for (const candidate of page.candidates) {
      if (candidateCurrentlyApplies(input, state, candidate, now.ms)) result.push(candidate.incident);
      if (result.length === limit) return result;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

function storeObservations(store: RunStore): StoreObservations {
  let state = observations.get(store);
  if (!state) {
    state = { context: new Map(), incidents: new Map(), recorded: new WeakMap() };
    observations.set(store, state);
  }
  return state;
}

function learnContextObservation(
  input: { readonly store: RunStore; readonly secretResolver: SecretResolver },
  state: StoreObservations,
  fact: ProviderInvocationFailureFact,
  now: number,
): ProviderModelRuntimeObservation | undefined {
  const budget = fact.contextBudget;
  const age = now - Date.parse(fact.settledAt);
  if (fact.classification.label !== "provider context window retry" || !budget
    || age < 0 || age > CONTEXT_OBSERVATION_TTL_MS || !scopeCurrentlyMatches(input, fact.scope)) return undefined;
  const attemptedWindow = budget.estimatedInputTokens + budget.reservedOutputTokens + budget.reservedRuntimeOverheadTokens;
  if (!Number.isSafeInteger(attemptedWindow) || attemptedWindow < 1) return undefined;
  const observedWindow = Math.max(MIN_CONTEXT_WINDOW_TOKENS,
    Math.min(Math.floor(attemptedWindow * 0.75), Math.floor(budget.contextWindowTokens * 0.75)));
  if (observedWindow >= budget.contextWindowTokens) return undefined;
  const previous = state.context.get(fact.identity.providerPresetId);
  if (previous && now >= Date.parse(previous.observation.observedAt) && scopeCurrentlyMatches(input, previous.scope)
    && previous.observation.observedContextWindowTokens <= observedWindow) return previous.observation;
  const observation: ProviderModelRuntimeObservation = Object.freeze({
    providerPresetId: fact.identity.providerPresetId, providerKind: fact.identity.providerKind,
    providerApi: fact.identity.providerApi, modelId: fact.identity.modelId,
    previousContextWindowTokens: budget.contextWindowTokens, observedContextWindowTokens: observedWindow,
    failureCode: "context_length_error", observedAt: fact.settledAt,
  });
  state.context.set(fact.identity.providerPresetId, { scope: fact.scope, observation });
  trimOldest(state.context);
  return observation;
}

function candidateCurrentlyApplies(
  input: { readonly store: RunStore; readonly secretResolver?: SecretResolver; readonly applicableProviderPresetId?: string | null },
  state: StoreObservations | undefined,
  candidate: AvailabilityIncidentCandidate,
  now: number,
): boolean {
  if (candidate.provenance === "generic") return true;
  if (candidate.provenance === "legacy_unclassified") {
    return candidate.incident.providerPresetId === undefined && candidate.incident.modelSignature === undefined;
  }
  const source = candidate.source;
  if (!source || now < Date.parse(source.settledAt) || input.applicableProviderPresetId === null
    || (input.applicableProviderPresetId !== undefined && source.identity.providerPresetId !== input.applicableProviderPresetId)) return false;
  const registered = source ? state?.incidents.get(source.observationId) : undefined;
  return Boolean(source && registered && registered.incidentId === candidate.incident.id
    && sameSource(source, registered.source) && scopeCurrentlyMatches(input, registered.scope));
}

function originalSource(fact: ProviderInvocationFailureFact): ProviderRuntimeAvailabilityIncidentSource {
  return Object.freeze({ observationId: randomUUID(), invocationId: fact.invocationId, taskId: fact.taskId,
    ...(fact.runId === undefined ? {} : { runId: fact.runId }),
    ...(fact.attemptId === undefined ? {} : { attemptId: fact.attemptId }),
    origin: fact.origin, admittedAt: fact.admittedAt, settledAt: fact.settledAt,
    identity: Object.freeze({ ...fact.identity }),
  });
}

function sameSource(left: ProviderRuntimeAvailabilityIncidentSource, right: ProviderRuntimeAvailabilityIncidentSource): boolean {
  return left.observationId === right.observationId && left.invocationId === right.invocationId
    && left.taskId === right.taskId && left.runId === right.runId && left.attemptId === right.attemptId
    && left.origin === right.origin && left.admittedAt === right.admittedAt && left.settledAt === right.settledAt
    && left.identity.providerPresetId === right.identity.providerPresetId && left.identity.providerKind === right.identity.providerKind
    && left.identity.providerApi === right.identity.providerApi && left.identity.modelId === right.identity.modelId
    && left.identity.configRevision === right.identity.configRevision;
}

function scopeCurrentlyMatches(
  input: { readonly store: RunStore; readonly secretResolver?: SecretResolver },
  scope: ProviderRuntimeObservationScope,
): boolean {
  if (!input.secretResolver) return false;
  const comparison = compareProviderRuntimeObservationScope({ store: input.store, secretResolver: input.secretResolver, scope });
  return comparison.state === "managed_generation_match" || comparison.state === "sampled_value_match";
}

function expireContextObservations(state: StoreObservations, now: number): void {
  for (const [key, cached] of state.context) {
    if (now - Date.parse(cached.observation.observedAt) > CONTEXT_OBSERVATION_TTL_MS) state.context.delete(key);
  }
}

function trimOldest<Value>(map: Map<string, Value>): void {
  while (map.size > MAX_PRIVATE_OBSERVATIONS) map.delete(map.keys().next().value!);
}

function currentTime(value?: string): { readonly iso: string; readonly ms: number } | undefined {
  try {
    const ms = value === undefined ? Date.now() : Date.parse(value);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : undefined;
  } catch { return undefined; }
}
