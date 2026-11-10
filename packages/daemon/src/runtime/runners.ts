import {
  DEFAULT_RUNNER_ID,
  LEGACY_PI_RUNNER_ID,
  normalizeRunnerId,
  type ApprovalActionType,
  type RunnerFallbackPolicy,
  type RunnerFallbackReason,
  type RunnerRequestSource,
} from "@ling-stack/core";
import type {
  RunnerToolHydrationCapability,
  RunnerToolSideEffectClass,
} from "@ling-stack/contracts";
import type { PiRunnerProviderApi } from "@ling-stack/runner-pi";
import type { RunnerAdapter } from "../context.js";
import {
  createUnverifiedToolExecutionConformance,
  resolveRunnerToolExecutionGate,
  type RunnerToolExecutionConformanceV1,
} from "./runner-tool-conformance.js";

export { resolveRunnerToolExecutionGate };
export type { RunnerToolExecutionConformanceV1 };
export type {
  RunnerToolExecutionGateBlocker,
  RunnerToolExecutionGateV1,
} from "./runner-tool-conformance.js";

export { DEFAULT_RUNNER_ID, LEGACY_PI_RUNNER_ID, normalizeRunnerId } from "@ling-stack/core";

export interface RegisteredRunner {
  readonly id: string;
  readonly displayName: string;
  readonly status: "enabled" | "disabled";
  readonly profileSelection?: "supported" | "unsupported";
  readonly adapter: RunnerAdapter;
  readonly aliases?: readonly string[];
  readonly supportedProviderApis?: readonly string[];
  readonly supportedTools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly toolHydration?: RunnerToolHydrationCapability;
  readonly featureFlag?: string;
  readonly disabledReason?: string;
  readonly executionBoundary: "embedded" | "external";
  readonly adapterRevision: string;
  readonly toolSideEffects: Readonly<Record<string, RunnerToolSideEffectClass>>;
  readonly toolExecutionConformance: RunnerToolExecutionConformanceV1;
  readonly resumeCapabilities: RunnerResumeCapabilitiesV1;
  readonly nativeResumeConformance: RunnerNativeResumeConformanceV1;
}

export interface RunnerResumeCapabilitiesV1 {
  readonly nativeResume: boolean;
  readonly hostApprovalContinuation: readonly ApprovalActionType[];
}

export interface RunnerNativeResumeConformanceV1 {
  /** Changes whenever the adapter protocol or verified resume behavior changes. */
  readonly revision: string;
  readonly readinessPassed: boolean;
  readonly conformancePassed: boolean;
  readonly abortPropagationVerified: boolean;
  readonly approvalBridgeVerified: boolean;
}

export type RunnerNativeResumeGateBlocker =
  | "runner_disabled"
  | "native_resume_not_declared"
  | "resume_adapter_missing"
  | "resume_readiness_not_passed"
  | "resume_conformance_not_passed"
  | "resume_abort_not_verified"
  | "resume_approval_bridge_not_verified"
  | "resume_capability_revision_changed";

export interface RunnerNativeResumeGateV1 {
  readonly ok: boolean;
  readonly revision: string;
  readonly blockers: readonly RunnerNativeResumeGateBlocker[];
}

export type RunnerRegistrationInput = Omit<
  RegisteredRunner,
  | "executionBoundary"
  | "adapterRevision"
  | "toolSideEffects"
  | "toolExecutionConformance"
  | "resumeCapabilities"
  | "nativeResumeConformance"
> & {
  readonly executionBoundary?: "embedded" | "external";
  readonly adapterRevision?: string;
  readonly toolSideEffects?: Readonly<Record<string, RunnerToolSideEffectClass>>;
  readonly toolExecutionConformance?: RunnerToolExecutionConformanceV1;
  readonly resumeCapabilities?: RunnerResumeCapabilitiesV1;
  readonly nativeResumeConformance?: RunnerNativeResumeConformanceV1;
};

export const noRunnerResumeCapabilities: RunnerResumeCapabilitiesV1 = {
  nativeResume: false,
  hostApprovalContinuation: [],
};

function unverifiedNativeResumeConformance(runnerId: string): RunnerNativeResumeConformanceV1 {
  return {
    revision: `${runnerId}:native-resume-unverified:v1`,
    readinessPassed: false,
    conformancePassed: false,
    abortPropagationVerified: false,
    approvalBridgeVerified: false,
  };
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

export function createRunnerRegistry(registrations: readonly RunnerRegistrationInput[], defaultRunnerId: string = DEFAULT_RUNNER_ID): RunnerRegistry {
  const runners: readonly RegisteredRunner[] = registrations.map((runner) => {
    const adapterRevision = runner.adapterRevision ?? `${runner.id}:adapter-unversioned:v1`;
    return {
      ...runner,
      executionBoundary: runner.executionBoundary ?? "embedded",
      adapterRevision,
      toolSideEffects: runner.toolSideEffects ?? {},
      toolExecutionConformance: runner.toolExecutionConformance ?? createUnverifiedToolExecutionConformance(adapterRevision),
      resumeCapabilities: runner.resumeCapabilities ?? noRunnerResumeCapabilities,
      nativeResumeConformance: runner.nativeResumeConformance ?? unverifiedNativeResumeConformance(runner.id),
    };
  });
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

export function resolveRunnerResumeCapabilities(runner: RegisteredRunner): RunnerResumeCapabilitiesV1 {
  return {
    nativeResume: resolveRunnerNativeResumeGate(runner).ok,
    hostApprovalContinuation: runner.resumeCapabilities.hostApprovalContinuation,
  };
}

export function resolveRunnerNativeResumeGate(
  runner: RegisteredRunner,
  expectedRevision?: string,
): RunnerNativeResumeGateV1 {
  // Injected registries and recovery fixtures may not have passed through
  // createRunnerRegistry. Missing evidence must disable native resume, not crash
  // an unrelated approval or deterministic-replay path.
  const conformance = runner.nativeResumeConformance ?? unverifiedNativeResumeConformance(runner.id);
  const blockers: RunnerNativeResumeGateBlocker[] = [];
  if (runner.status !== "enabled") blockers.push("runner_disabled");
  if (!runner.resumeCapabilities.nativeResume) blockers.push("native_resume_not_declared");
  if (typeof runner.adapter.resumeTask !== "function") blockers.push("resume_adapter_missing");
  if (!conformance.readinessPassed) blockers.push("resume_readiness_not_passed");
  if (!conformance.conformancePassed) blockers.push("resume_conformance_not_passed");
  if (!conformance.abortPropagationVerified) blockers.push("resume_abort_not_verified");
  if (!conformance.approvalBridgeVerified) blockers.push("resume_approval_bridge_not_verified");
  if (expectedRevision !== undefined && expectedRevision !== conformance.revision) {
    blockers.push("resume_capability_revision_changed");
  }
  return { ok: blockers.length === 0, revision: conformance.revision, blockers };
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
  const toolGate = resolveRunnerToolExecutionGate(runner, input.tools ?? []);
  if (!toolGate.ok) {
    return {
      code: "runner_tool_conformance_failed",
      message: `Runner ${runner.id} tool execution conformance failed: ${toolGate.blockers.join(", ")}.`,
    };
  }
  return undefined;
}
