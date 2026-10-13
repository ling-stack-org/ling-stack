import type { ProviderKind, ProviderPreset, RunSession, RunStore, SecretResolver } from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { resolveProviderContextBudget, type ContextBudget } from "../channels/context-packs.js";
import {
  providerPresetForRuntimeObservationScope,
  providerRuntimeScopeOwnedByStore,
  runtimeObservationScopeForProvider,
  type ProviderRuntimeObservationScope,
} from "../providers/runtime-observation-scope.js";

type ToolBudgetRun = Pick<RunSession,
  "providerPresetId" | "providerName" | "providerModel" | "providerSnapshot" | "workflowStepId">;

/**
 * Host-only Attempt budgeting. An actual Provider object and its nominal scope
 * must arrive together from the execution callback; public Run data cannot
 * reconstruct authority. HTTP/history callers use only frozen static data.
 */
export function resolveRunToolContextBudget(input: {
  readonly store: RunStore;
  readonly run: ToolBudgetRun;
  readonly actualProvider?: PiRunnerProviderConfig;
  readonly observationScope?: ProviderRuntimeObservationScope;
  readonly secretResolver?: SecretResolver;
  readonly now?: string;
}): ContextBudget {
  const kind = input.run.workflowStepId ? "workflow_step" : "channel_reply";
  const scope = input.observationScope;
  const exactScope = input.actualProvider && scope
    && providerRuntimeScopeOwnedByStore(input.store, scope)
    && runtimeObservationScopeForProvider(input.store, input.actualProvider) === scope ? scope : undefined;
  const capturedPreset = exactScope ? providerPresetForRuntimeObservationScope(exactScope) : undefined;
  const providerPreset = capturedPreset ?? staticProviderPreset(input.actualProvider ?? input.run.providerSnapshot, input.run);
  // The cache reader binds its original proof to this scope before making one
  // current sample. Two separately matching A/B samples cannot borrow B's window.
  const host = exactScope && capturedPreset
    ? { store: input.store, secretResolver: input.secretResolver, expectedScope: exactScope, now: input.now } : undefined;
  return resolveProviderContextBudget(providerPreset, kind, host);
}

/** Pick numeric/model own-data fields only: never execute snapshot getters or serialize credentials. */
function staticProviderPreset(value: unknown, run: ToolBudgetRun): ProviderPreset | undefined {
  const provider = ownText(value, "provider") ?? ownText(value, "providerId") ?? run.providerName;
  const model = ownText(value, "model") ?? run.providerModel;
  if (typeof provider !== "string" || provider.trim().length === 0 || typeof model !== "string" || model.trim().length === 0) return undefined;
  const api = staticApi(ownText(value, "api"));
  return {
    id: run.providerPresetId ?? "run-static-provider", kind: staticKind(provider, api), displayName: provider,
    providerId: provider, model, api, headers: {}, secretHeaderRefs: {}, input: ["text"], compat: {},
    capabilities: ["chat"], enabled: true, createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z",
    contextWindow: ownPositiveInteger(value, "contextWindow"), maxTokens: ownPositiveInteger(value, "maxTokens"),
  };
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

function ownText(value: unknown, key: string): string | undefined {
  const field = ownData(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function ownPositiveInteger(value: unknown, key: string): number | undefined {
  const field = ownData(value, key);
  return typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? field : undefined;
}

function staticApi(value?: string): NonNullable<PiRunnerProviderConfig["api"]> {
  switch (value) {
    case "openai-responses": case "openai-codex-responses": case "anthropic-messages":
    case "google-generative-ai": case "mistral-conversations": return value;
    default: return "openai-completions";
  }
}

function staticKind(provider: string, api: PiRunnerProviderConfig["api"]): ProviderKind {
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai") return "google";
  switch (provider) {
    case "openai": case "doubao": case "deepseek": case "minimax": case "glm": return provider;
    default: return "openai-compatible";
  }
}
