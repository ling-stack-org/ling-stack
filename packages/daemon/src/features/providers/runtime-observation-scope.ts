import { createHmac, randomBytes } from "node:crypto";
import {
  providerThinkingModesToLevelMap,
  type ProviderPreset,
  type ProviderStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { materializeProviderSecrets, type MaterializedProviderSecrets } from "./secret-materializer.js";

declare const configurationTicketBrand: unique symbol;
declare const observationScopeBrand: unique symbol;

/** Host-only nominal handles. Their serializable representation is empty. */
export interface ProviderConfigurationTicket {
  readonly [configurationTicketBrand]: true;
}
export interface ProviderRuntimeObservationScope {
  readonly [observationScopeBrand]: true;
}

export type ProviderRuntimeScopeComparison =
  | { readonly state: "managed_generation_match" | "sampled_value_match" }
  | {
      readonly state: "changed" | "unknown";
      readonly reason: "untrusted_scope" | "different_authority" | "configuration_changed"
        | "provider_deleted" | "authority_unavailable" | "credential_unavailable"
        | "effective_values_changed" | "resolved_provider_changed";
    };

export interface ProviderRuntimeScopeIdentity {
  readonly providerPresetId: string;
  readonly providerKind: ProviderPreset["kind"];
  readonly providerApi: ProviderPreset["api"];
  readonly modelId: string;
  readonly configRevision: number;
}

interface ConfigurationFact {
  readonly store: ProviderStoreFacet;
  readonly epoch: AuthorityEpoch;
  readonly preset: ProviderPreset;
  readonly configRevision: number;
  readonly configurationProof: string;
}
interface ResolutionFact {
  readonly store: ProviderStoreFacet;
  readonly epoch: AuthorityEpoch;
  /** Original configuration only; no materialized API key or secret-header values. */
  readonly preset: ProviderPreset;
  readonly providerId: string;
  readonly identity: ProviderRuntimeScopeIdentity;
  readonly configRevision: number;
  readonly configurationProof: string;
  readonly connectionProof: string;
  readonly credentialProof: string;
  readonly externalCredentials: boolean;
  readonly provider: WeakRef<PiRunnerProviderConfig>;
}
interface AuthorityEpoch { readonly key: Buffer }

// Store object identity, not a path/Provider ID, defines the current Host epoch.
// No materialized raw values or keyed proofs are present on public handles.
const epochs = new WeakMap<ProviderStoreFacet, AuthorityEpoch>();
const tickets = new WeakMap<ProviderConfigurationTicket, ConfigurationFact>();
const scopes = new WeakMap<ProviderRuntimeObservationScope, ResolutionFact>();
const providerScopes = new WeakMap<PiRunnerProviderConfig, ProviderRuntimeObservationScope>();

/** Capture the preset and durable revision with the existing single-statement read. */
export function captureProviderConfigurationTicket(
  store: ProviderStoreFacet,
  providerPresetId: string,
): ProviderConfigurationTicket | undefined {
  try {
    const snapshot = store.getProviderConfigurationSnapshot?.(providerPresetId);
    if (!snapshot || !validRevision(snapshot.configRevision)) return undefined;
    const preset = freezeConfiguration(structuredClone(snapshot.provider));
    const epoch = authorityEpoch(store);
    const ticket = Object.freeze({}) as ProviderConfigurationTicket;
    tickets.set(ticket, {
      store, epoch, preset, configRevision: snapshot.configRevision,
      configurationProof: proof(epoch, configurationValues(preset)),
    });
    return ticket;
  } catch {
    // Observation unavailability must not add a new model-call authorization gate.
    return undefined;
  }
}

export function providerPresetForConfigurationTicket(
  ticket: ProviderConfigurationTicket,
): ProviderPreset | undefined {
  const preset = tickets.get(ticket)?.preset;
  // Keep the ticket's fact immutable without freezing the Runner's existing
  // input/compat references or changing the resolver's normal output behavior.
  return preset ? structuredClone(preset) : undefined;
}

/** Bind the exact resolver output, not a clone, to its same-read effective values. */
export function bindResolvedProviderObservationScope(input: {
  readonly store: ProviderStoreFacet;
  readonly ticket: ProviderConfigurationTicket;
  readonly provider: PiRunnerProviderConfig;
  readonly materialized: MaterializedProviderSecrets;
  /** Actual source supplied to the same synchronous Host materializer. */
  readonly materializedPreset: ProviderPreset;
}): ProviderRuntimeObservationScope | undefined {
  const fact = tickets.get(input.ticket);
  if (!fact || fact.store !== input.store || epochs.get(input.store) !== fact.epoch) return undefined;
  try {
    if (configurationComparison(fact).state !== "managed_generation_match") return undefined;
    if (proof(fact.epoch, configurationValues(input.materializedPreset)) !== fact.configurationProof) return undefined;
    if (!matchesResolverOutput(fact.preset, input.provider, input.materialized)) return undefined;
    const scope = Object.freeze({}) as ProviderRuntimeObservationScope;
    scopes.set(scope, {
      store: fact.store, epoch: fact.epoch, preset: fact.preset, providerId: fact.preset.id,
      identity: Object.freeze({
        providerPresetId: fact.preset.id, providerKind: fact.preset.kind,
        providerApi: fact.preset.api, modelId: fact.preset.model, configRevision: fact.configRevision,
      }),
      configRevision: fact.configRevision, configurationProof: fact.configurationProof,
      connectionProof: proof(fact.epoch, input.provider),
      credentialProof: proof(fact.epoch, effectiveCredentials(input.materialized)),
      externalCredentials: hasExternalCredentials(fact.preset),
      provider: new WeakRef(input.provider),
    });
    providerScopes.set(input.provider, scope);
    return scope;
  } catch {
    return undefined;
  }
}

/** Host-only safe lineage; never a credential proof or a currentness assertion. */
export function providerRuntimeScopeIdentity(
  scope: ProviderRuntimeObservationScope,
): ProviderRuntimeScopeIdentity | undefined {
  return scopes.get(scope)?.identity;
}

/**
 * Original Host configuration for a live Attempt's static budget. This clone
 * is data, not reusable scope authority, and never contains materialized values.
 */
export function providerPresetForRuntimeObservationScope(
  scope: ProviderRuntimeObservationScope,
): ProviderPreset | undefined {
  const preset = scopes.get(scope)?.preset;
  return preset ? structuredClone(preset) : undefined;
}

/** Original authority only: historical facts need not match today's configuration. */
export function providerRuntimeScopeOwnedByStore(
  store: ProviderStoreFacet,
  scope: ProviderRuntimeObservationScope,
): boolean {
  const fact = scopes.get(scope);
  return Boolean(fact && fact.store === store && epochs.get(store) === fact.epoch);
}

/** Same original private authority, without rereading external values or exposing proofs. */
export function providerRuntimeObservationScopesEquivalent(
  left: ProviderRuntimeObservationScope,
  right: ProviderRuntimeObservationScope,
): boolean {
  const leftFact = scopes.get(left);
  const rightFact = scopes.get(right);
  return Boolean(leftFact && rightFact && leftFact.store === rightFact.store
    && leftFact.epoch === rightFact.epoch && epochs.get(leftFact.store) === leftFact.epoch
    && leftFact.configRevision === rightFact.configRevision
    && leftFact.identity.providerPresetId === rightFact.identity.providerPresetId
    && leftFact.identity.providerKind === rightFact.identity.providerKind
    && leftFact.identity.providerApi === rightFact.identity.providerApi
    && leftFact.identity.modelId === rightFact.identity.modelId
    && leftFact.configurationProof === rightFact.configurationProof
    && leftFact.connectionProof === rightFact.connectionProof
    && leftFact.credentialProof === rightFact.credentialProof);
}

/** Mutated/forged/cloned provider objects cannot borrow an original binding. */
export function runtimeObservationScopeForProvider(
  store: ProviderStoreFacet,
  provider: PiRunnerProviderConfig,
): ProviderRuntimeObservationScope | undefined {
  const scope = providerScopes.get(provider);
  if (!scope) return undefined;
  const fact = scopes.get(scope);
  if (!fact || fact.store !== store || epochs.get(store) !== fact.epoch) return undefined;
  try {
    if (proof(fact.epoch, provider) !== fact.connectionProof) return undefined;
    return scope;
  } catch {
    return undefined;
  }
}

/**
 * A current sample validates only its effective values, not external mutation
 * history. Synchronous materialization is revision-sandwiched; any uncertainty
 * removes observation applicability without disabling normal Provider calls.
 */
export function compareProviderRuntimeObservationScope(input: {
  readonly store: ProviderStoreFacet;
  readonly scope: ProviderRuntimeObservationScope;
  readonly secretResolver: SecretResolver;
}): ProviderRuntimeScopeComparison {
  const fact = scopes.get(input.scope);
  if (!fact) return { state: "unknown", reason: "untrusted_scope" };
  if (fact.store !== input.store || epochs.get(input.store) !== fact.epoch) {
    return { state: "unknown", reason: "different_authority" };
  }
  const provider = fact.provider.deref();
  try {
    // A live object must still match THIS receipt, not a later rebound scope.
    // Once it is collected the immutable same-read fact remains sufficient;
    // six-hour observations must not disappear merely because GC ran.
    if (provider && proof(fact.epoch, provider) !== fact.connectionProof) {
      return { state: "unknown", reason: "resolved_provider_changed" };
    }
    const before = configurationComparison(fact);
    if (before.state !== "managed_generation_match") return before;
    const snapshot = input.store.getProviderConfigurationSnapshot(fact.providerId);
    if (!snapshot) return { state: "changed", reason: "provider_deleted" };
    if (!configurationMatches(fact, snapshot.provider, snapshot.configRevision)) {
      return { state: "changed", reason: "configuration_changed" };
    }
    let materialized: MaterializedProviderSecrets;
    try {
      materialized = materializeProviderSecrets({
        store: input.store, preset: snapshot.provider, secretResolver: input.secretResolver,
      });
    } catch {
      return { state: "unknown", reason: "credential_unavailable" };
    }
    const after = configurationComparison(fact);
    if (after.state !== "managed_generation_match") return after;
    if (!completeCredentials(snapshot.provider, materialized)) {
      return { state: "unknown", reason: "credential_unavailable" };
    }
    if (proof(fact.epoch, effectiveCredentials(materialized)) !== fact.credentialProof) {
      return { state: "changed", reason: "effective_values_changed" };
    }
    return { state: fact.externalCredentials ? "sampled_value_match" : "managed_generation_match" };
  } catch {
    return { state: "unknown", reason: "authority_unavailable" };
  }
}

function authorityEpoch(store: ProviderStoreFacet): AuthorityEpoch {
  let epoch = epochs.get(store);
  if (!epoch) {
    epoch = { key: randomBytes(32) };
    epochs.set(store, epoch);
  }
  return epoch;
}

function configurationComparison(fact: ConfigurationFact | ResolutionFact): ProviderRuntimeScopeComparison {
  try {
    const id = fact.preset.id;
    const current = fact.store.getProviderConfigurationSnapshot(id);
    if (!current) return { state: "changed", reason: "provider_deleted" };
    return configurationMatches(fact, current.provider, current.configRevision)
      ? { state: "managed_generation_match" }
      : { state: "changed", reason: "configuration_changed" };
  } catch {
    return { state: "unknown", reason: "authority_unavailable" };
  }
}

function configurationMatches(
  fact: ConfigurationFact | ResolutionFact,
  preset: ProviderPreset,
  revision: number,
): boolean {
  return validRevision(revision) && revision === fact.configRevision
    && proof(fact.epoch, configurationValues(preset)) === fact.configurationProof;
}

function configurationValues(preset: ProviderPreset): unknown {
  // A check publication is not a configuration change. Core revision is still
  // mandatory; equal values alone cannot recognize managed A→B→A history.
  const { lastCheck: _check, createdAt: _created, updatedAt: _updated, ...configuration } = preset;
  return configuration;
}

function effectiveCredentials(materialized: MaterializedProviderSecrets): unknown {
  return { apiKey: materialized.apiKeySecret.value, headers: materialized.headers };
}

function completeCredentials(preset: ProviderPreset, materialized: MaterializedProviderSecrets): boolean {
  // Pi can fall back to SDK/ambient credentials when no runtime API key is
  // installed. Until the invocation supplies a deterministic anonymous path,
  // that connection has no complete Host proof (normal calls still work).
  if (!materialized.apiKeySecret.value) return false;
  if (preset.apiKeyRef && (!materialized.apiKeySecret.configured || !materialized.apiKeySecret.value)) return false;
  return Object.keys(preset.secretHeaderRefs).every(name =>
    materialized.secretHeaderStatuses[name]?.configured === true && Boolean(materialized.headers[name]));
}

function hasExternalCredentials(preset: ProviderPreset): boolean {
  // Secret-header refs always go through the external resolver. They have no
  // durable managed generation even if a custom resolver calls them "local".
  return Boolean(preset.apiKeyRef && !preset.apiKeyRef.startsWith("local:"))
    || Object.keys(preset.secretHeaderRefs).length > 0;
}

function matchesResolverOutput(
  preset: ProviderPreset,
  provider: PiRunnerProviderConfig,
  materialized: MaterializedProviderSecrets,
): boolean {
  if (!completeCredentials(preset, materialized)) return false;
  const transport = provider.providerTransport;
  if (preset.api === "openai-codex-responses") {
    if (transport !== "sse" && transport !== (preset.providerTransport ?? "auto")) return false;
  } else if (transport !== undefined) return false;
  const { providerTransport: _transport, ...actual } = provider;
  const expected = {
    provider: preset.providerId, model: preset.model, displayName: preset.displayName,
    apiKey: materialized.apiKeySecret.value, baseUrl: preset.baseUrl, api: preset.api,
    headers: materialized.headers, authHeader: preset.authHeader, reasoning: preset.reasoning,
    thinkingLevelMap: providerThinkingModesToLevelMap(preset.thinkingModes),
    input: preset.input, contextWindow: preset.contextWindow, maxTokens: preset.maxTokens, compat: preset.compat,
  };
  return canonical(actual) === canonical(expected);
}

function validRevision(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision > 0;
}

function proof(epoch: AuthorityEpoch, values: unknown): string {
  return createHmac("sha256", epoch.key).update(canonical(values)).digest("hex");
}

/** Stable JSON for bounded trusted configuration objects; never emit its bytes. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}`;
}

function freezeConfiguration<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeConfiguration(item);
    Object.freeze(value);
  }
  return value;
}
