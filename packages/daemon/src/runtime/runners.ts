import type { RunnerFallbackPolicy, RunnerFallbackReason, RunnerRequestSource } from "@ling-stack/core";
import type { RunnerToolHydrationCapability } from "@ling-stack/contracts";
import type { PiRunnerProviderApi } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../context.js";

export const DEFAULT_RUNNER_ID = "pi";
export const LEGACY_PI_RUNNER_ID = "pi-coding-agent";

export interface RegisteredRunner {
  readonly id: string;
  readonly displayName: string;
  readonly status: "enabled" | "disabled";
  readonly adapter: RunnerAdapter;
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly toolHydration?: RunnerToolHydrationCapability;
  readonly featureFlag?: string;
  readonly disabledReason?: string;
}

export interface RunnerResolutionInput {
  readonly requestedRunnerId?: string;
  readonly defaultRunnerId?: string;
  readonly allowedRunnerIds?: readonly string[];
  readonly requestSource?: RunnerRequestSource;
  readonly explicitFallbackPolicy?: RunnerFallbackPolicy;
  readonly implicitFallbackPolicy?: RunnerFallbackPolicy;
  readonly allowFallback?: boolean;
  readonly providerApi?: PiRunnerProviderApi;
  readonly tools?: readonly string[];
}

export interface RunnerResolution {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource: RunnerRequestSource;
  readonly fallbackAllowed: boolean;
  readonly runner: RegisteredRunner;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface RunnerRegistry {
  get(id: string): RegisteredRunner | undefined;
  list(): readonly RegisteredRunner[];
  resolve(input?: RunnerResolutionInput): RunnerResolution;
}

export function normalizeRunnerId(id: string | undefined): string | undefined {
  if (!id) {
    return undefined;
  }
  return id === LEGACY_PI_RUNNER_ID ? DEFAULT_RUNNER_ID : id;
}

export function createRunnerRegistry(runners: readonly RegisteredRunner[], defaultRunnerId: string = DEFAULT_RUNNER_ID): RunnerRegistry {
  const byId = new Map<string, RegisteredRunner>();
  for (const runner of runners) {
    registerRunnerId(byId, runner.id, runner);
    for (const alias of runner.aliases ?? []) {
      registerRunnerId(byId, alias, runner);
    }
  }
  const defaultId = normalizeRunnerId(defaultRunnerId) ?? DEFAULT_RUNNER_ID;

  return {
    get(id) {
      return byId.get(normalizeRunnerId(id) ?? id);
    },
    list() {
      return runners;
    },
    resolve(input = {}) {
      const requestedRunnerId = normalizeRunnerId(input.requestedRunnerId ?? input.defaultRunnerId ?? defaultId) ?? defaultId;
      const requestSource = input.requestSource ?? (input.requestedRunnerId ? "run_request" : "product_default");
      const allowFallback = input.allowFallback ?? shouldAllowFallback(input, requestSource);
      const allowedRunnerIds = normalizeAllowedRunnerIds(input.allowedRunnerIds);
      if (allowedRunnerIds && !allowedRunnerIds.has(requestedRunnerId)) {
        throw new UnsupportedRunnerError(requestedRunnerId, {
          code: "disabled_requested_runner",
          message: `Runner ${requestedRunnerId} is not allowed in this workspace.`,
        });
      }
      const fallbackRunner = byId.get(defaultId);
      if (!fallbackRunner) {
        throw new Error(`Default runner is not registered: ${defaultId}`);
      }
      const requestedRunner = byId.get(requestedRunnerId);
      const missingOrDisabled = getMissingOrDisabledReason(requestedRunnerId, requestedRunner);
      if (missingOrDisabled) {
        if (allowFallback && fallbackRunner.status === "enabled" && isRunnerAllowed(allowedRunnerIds, fallbackRunner.id)) {
          return {
            requestedRunnerId,
            effectiveRunnerId: fallbackRunner.id,
            requestSource,
            fallbackAllowed: allowFallback,
            runner: fallbackRunner,
            fallbackReason: missingOrDisabled,
          };
        }
        throw new UnsupportedRunnerError(requestedRunnerId, missingOrDisabled);
      }
      if (!requestedRunner) {
        throw new Error(`Runner resolution failed unexpectedly: ${requestedRunnerId}`);
      }
      const runner = requestedRunner;
      const unsupported = getUnsupportedCapabilityReason(runner, input);
      if (unsupported) {
        if (allowFallback && fallbackRunner.status === "enabled" && fallbackRunner.id !== runner.id && isRunnerAllowed(allowedRunnerIds, fallbackRunner.id)) {
          const fallbackUnsupported = getUnsupportedCapabilityReason(fallbackRunner, input);
          if (!fallbackUnsupported) {
            return {
              requestedRunnerId,
              effectiveRunnerId: fallbackRunner.id,
              requestSource,
              fallbackAllowed: allowFallback,
              runner: fallbackRunner,
              fallbackReason: unsupported,
            };
          }
        }
        throw new UnsupportedRunnerError(requestedRunnerId, unsupported);
      }
      return {
        requestedRunnerId,
        effectiveRunnerId: runner.id,
        requestSource,
        fallbackAllowed: allowFallback,
        runner,
      };
    },
  };
}

function shouldAllowFallback(input: RunnerResolutionInput, requestSource: RunnerRequestSource): boolean {
  const policy = isExplicitRunnerRequestSource(requestSource)
    ? input.explicitFallbackPolicy ?? "disabled"
    : input.implicitFallbackPolicy ?? "disabled";
  return policy === "allow_to_default";
}

function isExplicitRunnerRequestSource(source: RunnerRequestSource): boolean {
  return source === "teammate_default" || source === "workflow_step" || source === "run_request" || source === "user_explicit";
}

function normalizeAllowedRunnerIds(ids: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (!ids) {
    return undefined;
  }
  return new Set(ids.map((id) => normalizeRunnerId(id) ?? id));
}

function isRunnerAllowed(allowedRunnerIds: ReadonlySet<string> | undefined, runnerId: string): boolean {
  return !allowedRunnerIds || allowedRunnerIds.has(runnerId);
}

export class UnsupportedRunnerError extends Error {
  readonly code = "unsupported_runner";
  readonly requestedRunnerId: string;
  readonly fallbackReason: RunnerFallbackReason;

  constructor(requestedRunnerId: string, fallbackReason: RunnerFallbackReason) {
    super(fallbackReason.message);
    this.requestedRunnerId = requestedRunnerId;
    this.fallbackReason = fallbackReason;
  }
}

function registerRunnerId(byId: Map<string, RegisteredRunner>, id: string, runner: RegisteredRunner): void {
  const normalized = normalizeRunnerId(id) ?? id;
  const existing = byId.get(normalized);
  if (existing && existing.id !== runner.id) {
    throw new Error(`Duplicate runner id or alias: ${id}`);
  }
  byId.set(normalized, runner);
}

function getMissingOrDisabledReason(
  requestedRunnerId: string,
  runner: RegisteredRunner | undefined,
): RunnerFallbackReason | undefined {
  if (!runner) {
    return {
      code: "missing_requested_runner",
      message: `Runner ${requestedRunnerId} is not registered; using default runner ${DEFAULT_RUNNER_ID}.`,
    };
  }
  if (runner.status !== "enabled") {
    return {
      code: "disabled_requested_runner",
      message: `Runner ${requestedRunnerId} is not enabled; using default runner ${DEFAULT_RUNNER_ID}.`,
    };
  }
  return undefined;
}

function getUnsupportedCapabilityReason(
  runner: RegisteredRunner,
  input: RunnerResolutionInput,
): RunnerFallbackReason | undefined {
  if (input.providerApi && runner.supportedProviderApis && !runner.supportedProviderApis.includes(input.providerApi)) {
    return {
      code: "unsupported_provider_api",
      message: `Runner ${runner.id} does not support provider api ${input.providerApi}.`,
    };
  }
  const unsupportedTool = input.tools?.find((tool) => runner.supportedTools && !runner.supportedTools.includes(tool));
  if (unsupportedTool) {
    return {
      code: "unsupported_tool",
      message: `Runner ${runner.id} does not support tool ${unsupportedTool}.`,
    };
  }
  return undefined;
}
