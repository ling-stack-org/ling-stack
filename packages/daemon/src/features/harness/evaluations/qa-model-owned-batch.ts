import { realpathSync } from "node:fs";
import type { RunEvaluationQaBatchV1 } from "@ling-stack/contracts";
import type { RunEvaluationQaStore, ProviderStoreFacet, SecretResolver } from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { copyImmutableTaskData } from "./task-worker-input.js";
import { qaModelRecord, qaModelString } from "./qa-model-json.js";
import { runEvaluationQaModelConfigurationFacts, runEvaluationQaModelConfigurationSnapshot,
  type RunEvaluationQaModelConfiguration } from "./qa-model-preparation.js";
import type { RunEvaluationQaMaterializedProvider } from "./qa-model-transport.js";
import { compareProviderRuntimeObservationScope, providerRuntimeScopeIdentity,
  runtimeObservationScopeForProvider } from "../../providers/runtime-observation-scope.js";

declare const ownedBatchBrand: unique symbol;
export interface RunEvaluationQaOwnedModelBatch { readonly [ownedBatchBrand]: true }
interface OwnedBatch {
  readonly store: RunEvaluationQaStore;
  readonly batch: RunEvaluationQaBatchV1;
  readonly canonicalCwd: string;
  readonly configuration: RunEvaluationQaModelConfiguration;
  readonly provider: RunEvaluationQaMaterializedProvider;
  readonly materializeProvider: () => RunEvaluationQaMaterializedProvider | Promise<RunEvaluationQaMaterializedProvider>;
  readonly assertCredentialCurrent: () => void;
  invalidated: boolean;
}
const batches = new WeakMap<RunEvaluationQaOwnedModelBatch, OwnedBatch>();

/** Explicit fresh Host activation only: a saved batch DTO cannot recover lost private credential proof. */
interface OwnedBatchActivationOptions {
  readonly store: RunEvaluationQaStore;
  readonly qaWorkspaceCwd: string;
  readonly configuration: RunEvaluationQaModelConfiguration;
  readonly configSnapshotRef: string;
  readonly materializeProvider: () => RunEvaluationQaMaterializedProvider | Promise<RunEvaluationQaMaterializedProvider>;
  /** Host closure, not an executor-authenticated DTO; production uses the existing D1 scope builder below. */
  readonly assertCredentialCurrent: () => void;
  readonly now: string;
  readonly signal?: AbortSignal;
}
export async function createRunEvaluationQaOwnedModelBatch(options: OwnedBatchActivationOptions): Promise<RunEvaluationQaOwnedModelBatch> {
  try { return await activateOwnedBatch(options); }
  catch { throw new Error(options.signal?.aborted ? "evaluation_qa_activation_cancelled" : "evaluation_qa_activation_rejected"); }
}

async function activateOwnedBatch(options: OwnedBatchActivationOptions): Promise<RunEvaluationQaOwnedModelBatch> {
  options.signal?.throwIfAborted();
  callCurrentness(options.assertCredentialCurrent);
  options.signal?.throwIfAborted();
  const configurationFacts = runEvaluationQaModelConfigurationFacts(options.configuration);
  const canonicalCwd = realpathSync(options.qaWorkspaceCwd);
  const provider = captureProvider(await options.materializeProvider());
  options.signal?.throwIfAborted();
  callCurrentness(options.assertCredentialCurrent);
  options.signal?.throwIfAborted();
  const snapshot = runEvaluationQaModelConfigurationSnapshot(options.configuration) as { readonly input: {
    readonly providerId: string; readonly modelId: string; readonly api: string; readonly baseUrl: string } };
  if (provider.providerId !== snapshot.input.providerId || provider.modelId !== snapshot.input.modelId
    || provider.api !== snapshot.input.api || provider.baseUrl !== snapshot.input.baseUrl) throw new Error("evaluation_qa_provider_changed");
  const created = options.store.createRunEvaluationQaBatch({ configSnapshotRef: options.configSnapshotRef,
    configDigest: configurationFacts.configDigest, now: options.now });
  options.signal?.throwIfAborted();
  if (!created.ok) throw new Error("evaluation_qa_activation_rejected");
  const batch = copyImmutableTaskData(created.value);
  const scope = copyImmutableTaskData(options.store.getRunEvaluationQaScope());
  options.signal?.throwIfAborted();
  if (!scope || scope.canonicalWorkspaceCwd !== canonicalCwd || scope.namespaceId !== batch.namespaceId) {
    throw new Error("evaluation_qa_workspace_invalid");
  }
  const handle = Object.freeze({}) as RunEvaluationQaOwnedModelBatch;
  batches.set(handle, { store: options.store, batch, canonicalCwd, configuration: options.configuration,
    provider, materializeProvider: options.materializeProvider, assertCredentialCurrent: options.assertCredentialCurrent, invalidated: false });
  return handle;
}

/** No credential digest or value is exposed. Root can enroll only this fresh batch's explicit QA tasks. */
export function runEvaluationQaOwnedModelBatchFacts(handle: RunEvaluationQaOwnedModelBatch): RunEvaluationQaBatchV1 {
  return ownedBatchFor(handle).batch;
}

/** Host-internal closure access only; no serialization restores authority or secrets. */
export function runEvaluationQaOwnedModelBatchInput(handle: RunEvaluationQaOwnedModelBatch) {
  const owned = ownedBatchFor(handle);
  return Object.freeze({ store: owned.store, batch: owned.batch, canonicalCwd: owned.canonicalCwd,
    configuration: owned.configuration,
    async currentProvider(signal: AbortSignal): Promise<RunEvaluationQaMaterializedProvider> {
      signal.throwIfAborted();
      if (owned.invalidated) throw new Error("evaluation_qa_credentials_changed");
      assertCurrentness(owned);
      signal.throwIfAborted();
      const current = captureProvider(await owned.materializeProvider());
      signal.throwIfAborted();
      assertCurrentness(owned);
      signal.throwIfAborted();
      if (!sameProvider(owned.provider, current)) { owned.invalidated = true; throw new Error("evaluation_qa_credentials_changed"); }
      return current;
    },
    assertGeneration(): void {
      if (owned.invalidated) throw new Error("evaluation_qa_credentials_changed");
      assertCurrentness(owned);
    },
  });
}

/** Reuse D1's original same-read scope, managed revision sandwich and current external effective-value sample. */
export function createRunEvaluationQaProviderCurrentness(options: {
  readonly store: ProviderStoreFacet;
  readonly originalProvider: PiRunnerProviderConfig;
  readonly configuration: RunEvaluationQaModelConfiguration;
  readonly secretResolver: SecretResolver;
}): () => void {
  const scope = runtimeObservationScopeForProvider(options.store, options.originalProvider);
  const identity = scope ? providerRuntimeScopeIdentity(scope) : undefined;
  const snapshot = runEvaluationQaModelConfigurationSnapshot(options.configuration) as { readonly input: {
    readonly providerPresetId: string; readonly configRevision: number; readonly api: string; readonly modelId: string;
    readonly providerId: string; readonly baseUrl: string } };
  if (!scope || !identity || identity.providerPresetId !== snapshot.input.providerPresetId
    || identity.configRevision !== snapshot.input.configRevision || identity.providerApi !== snapshot.input.api
    || identity.modelId !== snapshot.input.modelId || options.originalProvider.provider !== snapshot.input.providerId
    || options.originalProvider.baseUrl !== snapshot.input.baseUrl || options.originalProvider.model !== snapshot.input.modelId
    || options.originalProvider.api !== snapshot.input.api) throw new Error("evaluation_qa_provider_scope_untrusted");
  return (): void => {
    const comparison = compareProviderRuntimeObservationScope({ store: options.store, scope, secretResolver: options.secretResolver });
    if (comparison.state !== "managed_generation_match" && comparison.state !== "sampled_value_match") {
      throw new Error("evaluation_qa_credentials_changed");
    }
  };
}

function ownedBatchFor(handle: RunEvaluationQaOwnedModelBatch): OwnedBatch {
  const owned = batches.get(handle);
  if (!owned) throw new Error("evaluation_qa_activation_untrusted");
  return owned;
}
function assertCurrentness(owned: OwnedBatch): void {
  try { callCurrentness(owned.assertCredentialCurrent); }
  catch { owned.invalidated = true; throw new Error("evaluation_qa_credentials_changed"); }
}
function callCurrentness(checker: () => void): void {
  if (checker() !== undefined) throw new Error("evaluation_qa_currentness_not_synchronous");
}
function captureProvider(value: RunEvaluationQaMaterializedProvider): RunEvaluationQaMaterializedProvider {
  const provider = qaModelRecord(value, ["providerId", "modelId", "api", "baseUrl"], ["apiKey", "headers", "authHeader"]);
  for (const key of ["providerId", "modelId", "baseUrl"]) qaModelString(provider[key], key === "baseUrl" ? 2_048 : 500);
  if (provider.api !== "openai-completions" || (provider.authHeader !== undefined && typeof provider.authHeader !== "boolean")) {
    throw new Error("evaluation_qa_provider_unsupported");
  }
  if (provider.apiKey !== undefined) qaModelString(provider.apiKey, 8_192);
  if (provider.headers !== undefined) {
    if (!provider.headers || typeof provider.headers !== "object" || Array.isArray(provider.headers)) throw new Error("evaluation_qa_auth_invalid");
    for (const header of Object.values(provider.headers)) if (typeof header !== "string") throw new Error("evaluation_qa_auth_invalid");
  }
  return provider as unknown as RunEvaluationQaMaterializedProvider;
}
function sameProvider(left: RunEvaluationQaMaterializedProvider, right: RunEvaluationQaMaterializedProvider): boolean {
  const headers = (provider: RunEvaluationQaMaterializedProvider): string => JSON.stringify(Object.entries(provider.headers ?? {})
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName)));
  return left.providerId === right.providerId && left.modelId === right.modelId && left.api === right.api && left.baseUrl === right.baseUrl
    && left.apiKey === right.apiKey && left.authHeader === right.authHeader && headers(left) === headers(right);
}
