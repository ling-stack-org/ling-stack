import { isChannelIntentExecutionPlanV1, type ChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";
import type { AiTeammate, RunStore } from "@ling-stack/core";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { HttpError } from "../../errors.js";
import { loadWorkspaceRuntimeSettings } from "../../runtime/runner-settings.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { isNativeRestrictedCommandRuntime, type NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";
import { requiredToolsForExecutionOperations } from "./workflow-operation-ownership.js";

/**
 * Admit only the typed effects verified through the Pi tool-before gate.
 * This is a capability interlock, not authorization or a kernel sandbox.
 * The existing graph serializes participants, so a later owner cannot supply
 * an earlier owner's input. Optional effects are not yet represented durably.
 */
export function assertChannelOperationRuntimeReady(
  plan: ChannelIntentExecutionPlanV1 | undefined,
  operationOwners: ReadonlyMap<string, number>,
  restrictedCommandRuntime?: NativeRestrictedCommandRuntime,
  hostCapabilityAvailable?: (capabilityId: "host.open_local_target") => boolean,
): void {
  if (!plan || (plan.bindingVersion === undefined
    && !plan.operations.some((operation) => operation.binding !== undefined || operation.kind === "file_read"))) return;
  if (plan.bindingVersion !== 1 || !isChannelIntentExecutionPlanV1(plan)) throw notReady("Typed operation plan or fingerprint is invalid.");
  const unsupported = plan.operations.find((operation) => !operation.required || !operation.binding
    || !["file_read", "file_create", "run_command", "open_local_target"].includes(operation.kind));
  if (unsupported || plan.operations.length === 0) {
    throw notReady(`Operation ${unsupported?.id ?? "plan"} has no verified required file-read or exclusive-create capability.`);
  }
  const readKeys = new Set<string>();
  const outputPaths = new Set<string>();
  for (const operation of plan.operations) {
    const owner = operationOwners.get(operation.id);
    if (owner === undefined || operation.dependsOn.some((dependencyId) => {
      const dependencyOwner = operationOwners.get(dependencyId);
      return dependencyOwner === undefined || dependencyOwner > owner;
    })) {
      throw notReady(`Operation ${operation.id} requires an unavailable or later participant's evidence.`);
    }
    if (operation.kind === "run_command") {
      if (!isNativeRestrictedCommandRuntime(restrictedCommandRuntime)) throw notReady(`Operation ${operation.id} requires the verified restricted command backend.`);
      const binding = operation.binding!;
      if (operation.commandMatchPolicy?.kind !== "exact_command" || binding.effectScope.exactCommands.length !== 1
        || binding.effectScope.writePaths.length || binding.effectScope.allowNetworkAccess || binding.effectScope.allowEnvironmentAccess) {
        throw notReady(`Operation ${operation.id} requires an unavailable command scope.`);
      }
      try { restrictedCommandRuntime.assertAvailable(operation.commandMatchPolicy.command); }
      catch (error) { throw notReady(error instanceof Error ? error.message : "Restricted command backend verification failed."); }
      const key = `${owner}:command:${operation.commandMatchPolicy.command}`;
      if (readKeys.has(key)) throw notReady(`Operation ${operation.id} has an ambiguous duplicate command.`);
      readKeys.add(key);
      continue;
    }
    if (operation.kind === "open_local_target") {
      const binding = operation.binding!;
      if (hostCapabilityAvailable?.("host.open_local_target") !== true) {
        throw notReady(`Operation ${operation.id} requires the connected Ling Desktop Host preview.`);
      }
      if (binding.inputRefs.length !== 1 || binding.outputRefs.length !== 0
        || binding.effectScope.exactCommands.length !== 0
        || binding.effectScope.writePaths.length !== 0
        || binding.effectScope.readPaths.length !== 1
        || binding.effectScope.readPaths[0] !== binding.inputRefs[0]?.path
        || binding.effectScope.allowNetworkAccess || binding.effectScope.allowEnvironmentAccess) {
        throw notReady(`Operation ${operation.id} requires an unavailable Host preview scope.`);
      }
      const key = `${owner}:host-open:${binding.inputRefs[0]!.path}`;
      if (readKeys.has(key)) throw notReady(`Operation ${operation.id} has an ambiguous duplicate Host preview.`);
      readKeys.add(key);
      continue;
    }
    const path = operation.kind === "file_read" ? operation.binding!.inputRefs[0]!.path : operation.binding!.outputRefs[0]!.path;
    const key = operation.kind === "file_read" ? `${owner}:${path}` : path;
    const targets = operation.kind === "file_read" ? readKeys : outputPaths;
    if (targets.has(key)) throw notReady(`Operation ${operation.id} has an ambiguous duplicate effect target.`);
    targets.add(key);
  }
}

/** Reject unverified adapters before materializing workflow Tasks, then recheck at dispatch. */
export function assertChannelOperationRunnerReady(input: {
  readonly plan: ChannelIntentExecutionPlanV1 | undefined;
  readonly store: RunStore;
  readonly runnerRegistry?: RunnerRegistry;
  readonly participants: readonly { readonly teammate: AiTeammate; readonly providerBinding?: { readonly providerPresetId: string } }[];
}): void {
  if (input.plan?.bindingVersion !== 1) return;
  const registry = input.runnerRegistry;
  if (!registry) throw runnerUnavailable();
  const settings = loadWorkspaceRuntimeSettings(input.store, registry);
  for (const participant of input.participants) {
    const providerApi = participant.providerBinding ? input.store.getProviderPreset(participant.providerBinding.providerPresetId)?.api : undefined;
    if (providerApi === "media-job") throw runnerUnavailable();
    const resolution = registry.resolve({
      requestedRunnerId: participant.teammate.runnerId ?? settings.defaultRunnerId,
      defaultRunnerId: settings.defaultRunnerId,
      allowedRunnerIds: settings.allowedRunnerIds,
      requestSource: participant.teammate.runnerId ? "teammate_default" : "workspace_default",
      explicitFallbackPolicy: settings.explicitRunnerFallback,
      implicitFallbackPolicy: settings.implicitRunnerFallback,
      providerApi,
      tools: requiredToolsForExecutionOperations(input.plan.operations.filter((operation) => operation.binding?.ownerParticipantId === participant.teammate.id)),
    });
    if (!(resolution.runner.adapter instanceof PiRunnerAdapter)) throw runnerUnavailable();
  }
}

function runnerUnavailable(): HttpError {
  return new HttpError(409, "operation_binding_runner_gate_unavailable", "This runner has no verified universal typed tool-before gate. No Task or Run was created.");
}

function notReady(reason: string): HttpError {
  return new HttpError(409, "operation_binding_runtime_not_ready", `${reason} No Task or Run was created.`);
}
