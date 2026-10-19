import type { ExecutionEngineInstallationProbe, ExecutionEngineProfile } from "@ling-stack/contracts";
import { resolve } from "node:path";
import {
  ExecutionEngineProfileError,
  type ExecutionEngineProfileStore,
  type NativeExecutionSelection,
  type SecretResolver,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import type { NativeRunAdmissionInput, NativeRunTargetDispatcher, NativeRunTargetDispatchInput } from "../runs/native-run-dispatcher.js";
import { assertNativeExecutionAccepted, type NativeAdmissionOptions } from "./native-admission.js";
import { probeEngineInstallation } from "./installation-probe.js";
import { executeOwnedOpenClawPrompt, type OwnedOpenClawExecutionOptions } from "../../runtime/acp/openclaw-owned-execution.js";
import { acpConfigurationFingerprint } from "../../runtime/acp/journaled-lifecycle.js";
import { executeOwnedKimiPrompt, type OwnedKimiExecutionOptions } from "../../runtime/acp/kimi-owned-execution.js";
import { executeOwnedCodexTurn, type OwnedCodexExecutionOptions } from "../../runtime/adapters/codex/owned-execution.js";
import { codexConfigurationFingerprint } from "../../runtime/adapters/codex/journaled-lifecycle.js";
import type { CodexThreadConfiguration } from "../../runtime/adapters/codex/live-client.js";

export interface ExecutionEngineRunTargetDispatcherOptions extends NativeAdmissionOptions {
  readonly getProfileStore: () => ExecutionEngineProfileStore;
  readonly secretResolver: SecretResolver;
  readonly probeInstallation?: (
    profile: ExecutionEngineProfile,
    signal: AbortSignal,
  ) => Promise<ExecutionEngineInstallationProbe>;
  readonly executeOpenClaw?: (
    input: OwnedOpenClawExecutionOptions,
  ) => ReturnType<typeof executeOwnedOpenClawPrompt>;
  readonly executeCodex?: (
    input: OwnedCodexExecutionOptions,
  ) => ReturnType<typeof executeOwnedCodexTurn>;
  readonly executeKimi?: (
    input: OwnedKimiExecutionOptions,
  ) => ReturnType<typeof executeOwnedKimiPrompt>;
}

class NativeExecutionTargetError extends Error {
  readonly code = "native_execution_unavailable";

  constructor() {
    super("native_execution_unavailable");
  }
}

/** Resolves one saved native binding into its target-owned execution path. */
export function createExecutionEngineRunTargetDispatcher(
  options: ExecutionEngineRunTargetDispatcherOptions,
): NativeRunTargetDispatcher {
  const probe = options.probeInstallation
    ?? ((profile: ExecutionEngineProfile, signal: AbortSignal) => probeEngineInstallation(profile, { signal }));
  const executeOpenClaw = options.executeOpenClaw ?? executeOwnedOpenClawPrompt;
  const executeCodex = options.executeCodex ?? executeOwnedCodexTurn;
  const executeKimi = options.executeKimi ?? executeOwnedKimiPrompt;

  const prepare = async (input: NativeRunAdmissionInput) => {
      const binding = input.runRequest.executionBinding;
      if (binding.engineId !== "openclaw-acp" && binding.engineId !== "codex-app-server" && binding.engineId !== "kimi-acp") unavailable();
      if ((binding.engineId === "openclaw-acp" && binding.nativeModelId !== undefined)
        || (binding.engineId === "codex-app-server" && !binding.nativeModelId)) unavailable();

      const profileStore = options.getProfileStore();
      const profile = profileStore.get(binding.engineId);
      if (!profile) throw new ExecutionEngineProfileError("profile_not_found");
      if (profile.id !== binding.profileId || profile.revision !== binding.profileRevision) {
        throw new ExecutionEngineProfileError("profile_revision_conflict");
      }
      profileStore.assertCurrentAuthProfile(profile);
      if (binding.engineId === "openclaw-acp" && (!profile.configuration.openclaw || !profile.configuration.secretRef)) unavailable();
      if (binding.engineId === "kimi-acp") {
        const apiKeyProfile = Boolean(profile.configuration.secretRef);
        if (apiKeyProfile
          ? !profile.configuration.kimi || binding.nativeModelId !== undefined || profile.configuration.kimiLoginRegion !== undefined
          : !profile.configuration.kimiLoginRegion || profile.configuration.kimi !== undefined) unavailable();
      }

      input.signal.throwIfAborted();
      const installation = await probe(profile, input.signal);
      input.signal.throwIfAborted();
      if (!installationMatchesProfile(installation, profile)) unavailable();
      const assertAcceptance = await assertNativeExecutionAccepted(options, input, profile, installation);
      const assertCurrentAuthority = () => {
        profileStore.assertCurrentAuthProfile(profile);
        assertAcceptance();
      };
      profileStore.assertCurrentAuthProfile(profile);
      input.assertCurrentAuthority?.();
      return { profileStore, profile, installation, assertCurrentAuthority };
  };

  return {
    async assertAvailable(input) { await prepare(input); },
    async dispatch(input) {
      const { profileStore, profile, installation, assertCurrentAuthority } = await prepare(input);
      const binding = input.runRequest.executionBinding;

      if (binding.engineId === "kimi-acp") {
        const configuration = {
          cwd: input.runRequest.cwd,
          ...(binding.nativeModelId ? { modelId: binding.nativeModelId } : {}),
          ...(input.effectivePolicySnapshot.conversationMode === "plan" ? { modeId: "plan" as const } : {}),
        };
        const target = { engineId: "kimi-acp" as const, expectedVersion: installation.runtimeVersion };
        const selection: NativeExecutionSelection = {
          engineId: "kimi-acp",
          profileId: profile.id,
          profileRevision: profile.revision,
          profileFingerprint: profile.configurationFingerprint,
          ...(binding.nativeModelId ? { modelId: binding.nativeModelId } : {}),
          configurationFingerprint: acpConfigurationFingerprint(target, configuration),
        };
        const fence = toRuntimeAttemptFence(input.attempt);
        const generation = input.store.resolveNativeExecutionGeneration({ runId: input.run.id, fence, selection });
        return executeKimi({
          store: input.store,
          reservation: { runId: input.run.id, generation, fence, selection },
          configuration,
          input: [{ type: "text", text: input.runRequest.task.prompt }],
          process: {
            executablePath: profile.configuration.executablePath,
            executableDigest: installation.executableDigest,
            kimiHome: profileStore.getAuthProfileDirectory(profile),
            expectedVersion: installation.runtimeVersion,
          },
          authentication: profile.configuration.secretRef
            ? { store: profileStore, profile, secretResolver: options.secretResolver }
            : { store: profileStore, profile, region: profile.configuration.kimiLoginRegion! },
          approvalPolicy: {
            policy: input.approvalPolicy,
            approvalProfile: input.runRequest.approvalProfile,
            effectivePolicySnapshot: input.effectivePolicySnapshot,
          },
          output: { requireAssistantText: true },
          onEvent: input.onEvent,
          onApprovalWaitChanged: input.onApprovalWaitChanged,
          onLocalLifetime: input.onLocalLifetime,
          assertCurrentAuthority,
          signal: input.signal,
        });
      }

      if (binding.engineId === "codex-app-server") {
        const configuration: CodexThreadConfiguration = {
          cwd: input.runRequest.cwd,
          model: binding.nativeModelId!,
          modelProvider: "openai",
          approvalPolicy: "on-request",
          sandbox: codexSandbox(input),
        };
        const selection: NativeExecutionSelection = {
          engineId: "codex-app-server",
          profileId: profile.id,
          profileRevision: profile.revision,
          profileFingerprint: profile.configurationFingerprint,
          modelId: binding.nativeModelId,
          configurationFingerprint: codexConfigurationFingerprint(configuration),
        };
        const fence = toRuntimeAttemptFence(input.attempt);
        const generation = input.store.resolveNativeExecutionGeneration({
          runId: input.run.id,
          fence,
          selection,
        });
        return executeCodex({
          store: input.store,
          reservation: { runId: input.run.id, generation, fence, selection },
          configuration,
          input: { input: [{ type: "text", text: input.runRequest.task.prompt, text_elements: [] }] },
          process: {
            executablePath: profile.configuration.executablePath,
            executableDigest: installation.executableDigest,
            codexHome: profileStore.getAuthProfileDirectory(profile),
          },
          authentication: { store: profileStore, profile, secretResolver: options.secretResolver },
          approvalPolicy: {
            policy: input.approvalPolicy,
            approvalProfile: input.runRequest.approvalProfile,
            effectivePolicySnapshot: input.effectivePolicySnapshot,
          },
          output: { requireAssistantText: true },
          onEvent: input.onEvent,
          onApprovalWaitChanged: input.onApprovalWaitChanged,
          onLocalLifetime: input.onLocalLifetime,
          assertCurrentAuthority,
          signal: input.signal,
        });
      }

      const openclaw = profile.configuration.openclaw;
      if (!openclaw || !profile.configuration.secretRef) unavailable();
      const configuration = { cwd: input.runRequest.cwd };
      const target = {
        engineId: "openclaw-acp" as const,
        expectedVersion: installation.runtimeVersion,
        agentId: openclaw.agentId,
      };
      const selection: NativeExecutionSelection = {
        engineId: "openclaw-acp",
        profileId: profile.id,
        profileRevision: profile.revision,
        profileFingerprint: profile.configurationFingerprint,
        configurationFingerprint: acpConfigurationFingerprint(target, configuration),
      };
      const fence = toRuntimeAttemptFence(input.attempt);
      const generation = input.store.resolveNativeExecutionGeneration({
        runId: input.run.id,
        fence,
        selection,
      });

      return executeOpenClaw({
        store: input.store,
        reservation: { runId: input.run.id, generation, fence, selection },
        configuration,
        input: [{ type: "text", text: input.runRequest.task.prompt }],
        process: {
          executablePath: profile.configuration.executablePath,
          executableDigest: installation.executableDigest,
          expectedVersion: installation.runtimeVersion,
        },
        authentication: { store: profileStore, profile, secretResolver: options.secretResolver },
        approvalPolicy: {
          policy: input.approvalPolicy,
          approvalProfile: input.runRequest.approvalProfile,
          effectivePolicySnapshot: input.effectivePolicySnapshot,
        },
        output: { requireAssistantText: true },
        onEvent: input.onEvent,
        onApprovalWaitChanged: input.onApprovalWaitChanged,
        onLocalLifetime: input.onLocalLifetime,
        assertCurrentAuthority,
        signal: input.signal,
      });
    },
  };
}

function codexSandbox(input: NativeRunTargetDispatchInput): CodexThreadConfiguration["sandbox"] {
  const policy = input.effectivePolicySnapshot;
  if (policy.conversationMode === "plan" || policy.workspaceAccessMode === "read_only") {
    return { type: "readOnly", networkAccess: false };
  }
  if (policy.workspaceAccessMode === "full_access") return { type: "dangerFullAccess" };
  if (policy.workspaceAccessMode !== "workspace_write") unavailable();
  const writableRoots = [...new Set(policy.allowedWritePaths.map((path) => resolve(input.runRequest.cwd, path)))];
  if (writableRoots.length === 0) unavailable();
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

function installationMatchesProfile(
  installation: ExecutionEngineInstallationProbe,
  profile: ExecutionEngineProfile,
): installation is ExecutionEngineInstallationProbe & {
  readonly status: "installed";
  readonly runtimeVersion: string;
  readonly executableDigest: string;
} {
  return installation.status === "installed"
    && installation.profileId === profile.id
    && installation.profileRevision === profile.revision
    && installation.configurationFingerprint === profile.configurationFingerprint
    && typeof installation.runtimeVersion === "string"
    && installation.runtimeVersion.length > 0
    && typeof installation.executableDigest === "string"
    && /^[a-f0-9]{64}$/.test(installation.executableDigest);
}

function unavailable(): never {
  throw new NativeExecutionTargetError();
}
