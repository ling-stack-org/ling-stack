import { resolve } from "node:path";
import type { ExecutionEngineInstallationProbe, ExecutionEngineProfile, RunnerAcceptanceIdentity, WorkspaceRuntimeSettings } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { assessRunnerAcceptance } from "../../runtime/runner-acceptance.js";
import { runnerAcceptanceFingerprint } from "../../runtime/runner-acceptance-store.js";
import type { NativeRunAdmissionInput } from "../runs/native-run-dispatcher.js";

export interface NativeAdmissionOptions {
  /** Trusted host composition only; never read these callbacks from a request or workspace config. */
  readonly readWorkspaceSettings?: (store: RunStore) => WorkspaceRuntimeSettings;
  readonly readAcceptanceEvidence?: (identity: RunnerAcceptanceIdentity) => unknown | Promise<unknown>;
}

/** Installation and connection observations cannot self-certify execution acceptance. */
export async function assertNativeExecutionAccepted(options: NativeAdmissionOptions, input: NativeRunAdmissionInput,
  profile: ExecutionEngineProfile, installation: ExecutionEngineInstallationProbe): Promise<() => void> {
  const current = (): RunnerAcceptanceIdentity => {
    const settings = options.readWorkspaceSettings?.(input.store);
    if (!settings || settings.schemaVersion !== 2 || !settings.allowedRunnerIds.includes(profile.configuration.engineId)) {
      throw new HttpError(409, "native_execution_not_allowed", "Explicit workspace authorization is required.");
    }
    const binding = input.runRequest.executionBinding;
    const parent = input.runRequest.parentRunId ? input.store.getRun(input.runRequest.parentRunId) : undefined;
    const threadId = input.runRequest.threadId ?? parent?.threadId;
    const thread = threadId ? input.store.getLingThread(threadId) : undefined;
    const surface: RunnerAcceptanceIdentity["workflowSurface"] = input.runRequest.workflowStepId ? "workflow"
      : thread?.kind === "conversation" ? "normal_conversation" : thread?.kind === "teammate_direct" ? "private_chat"
      : thread?.kind === "automation" ? "automation" : thread?.kind === "external_work" ? "external_work"
      : input.runRequest.task.channelId ? "channel" : input.workflowSurface ?? "task";
    return { runnerId: binding.engineId, runtimeVersion: installation.runtimeVersion ?? "",
      sdkVersion: binding.engineId === "codex-app-server" ? "codex-app-server-schema-v2" : "@agentclientprotocol/sdk@1.9.0",
      adapterVersion: `${binding.engineId}:native-adapter-v1`, executableDigest: installation.executableDigest ?? "",
      platform: process.platform, architecture: process.arch, profileId: profile.id, profileRevision: profile.revision,
      configurationFingerprint: runnerAcceptanceFingerprint({ profile: profile.configurationFingerprint, binding }),
      workspaceId: runnerAcceptanceFingerprint({ cwd: resolve(input.runRequest.workspaceCwd ?? input.runRequest.cwd), workspaceId: settings.workspaceId }),
      policyFingerprint: runnerAcceptanceFingerprint({ settings, effectivePolicy: input.effectivePolicySnapshot }), workflowSurface: surface };
  };
  input.signal.throwIfAborted();
  const identity = current();
  const evidence = await options.readAcceptanceEvidence?.(identity);
  input.signal.throwIfAborted();
  if (runnerAcceptanceFingerprint(identity) !== runnerAcceptanceFingerprint(current())) {
    throw new HttpError(409, "native_execution_verification_mismatch", "Execution identity changed during verification.");
  }
  const decision = assessRunnerAcceptance(identity, evidence);
  if (decision.status !== "accepted") throw new HttpError(409, `native_execution_${decision.reason}`, "Current execution verification is required.");
  input.assertCurrentAuthority?.();
  // Owned execution invokes this synchronously immediately before spawn/submit.
  // Production reads host storage synchronously; an async reader fails closed here.
  return () => {
    input.signal.throwIfAborted();
    if (runnerAcceptanceFingerprint(identity) !== runnerAcceptanceFingerprint(current())) {
      throw new HttpError(409, "native_execution_verification_mismatch", "Execution identity changed during verification.");
    }
    const finalDecision = assessRunnerAcceptance(identity, options.readAcceptanceEvidence?.(identity));
    if (finalDecision.status !== "accepted") throw new HttpError(409, `native_execution_${finalDecision.reason}`, "Current execution verification is required.");
    input.assertCurrentAuthority?.();
  };
}
