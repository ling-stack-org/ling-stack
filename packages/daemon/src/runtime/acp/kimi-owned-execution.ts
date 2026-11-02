import type { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import type { ExecutionEngineProfileStore, NativeSubmission, ReserveNativeExecutionInput, RunEventEnvelope, SecretResolver } from "@ling-stack/core";
import { assertKimiApiKey } from "../../features/execution-engines/kimi-auth-state.js";
import { kimiNativeEnvironment, prepareKimiNativeExecutable, verifyKimiNativeExecutable } from "../../features/execution-engines/kimi-native-executable.js";
import { EngineCredentialError, resolveEngineSecret } from "../../features/execution-engines/native-secrets.js";
import { withOwnedNativeProcess } from "../../features/execution-engines/owned-native-process.js";
import { prepareOwnedNativeSpawn } from "../../features/execution-engines/windows-supervisor.js";
import { preparePlatformNativeProcessLaunch } from "../sandbox/native-process-launch.js";
import { AcpJournaledLifecycle, acpConfigurationFingerprint, type AcpJournaledLifecycleOptions } from "./journaled-lifecycle.js";
import { KimiActionPreparer, type KimiActionPreparationOptions } from "./kimi-action-preparation.js";
import type { AcpPromptHandle } from "./live-client.js";
import { prepareKimiExecutionHome } from "./kimi-execution-home.js";
import type { KimiModelAuthentication } from "./kimi-model-transport.js";
import { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";
import { KimiHostFiles } from "./kimi-host-files.js";
import { KimiHostTerminals } from "./kimi-host-terminals.js";
import { readOnlyRunTools, riskyRunTools } from "@ling-stack/core";
import type { RestrictedCommandExecutablePin } from "../sandbox/restricted-command-runtime.js";

export interface KimiExecutionAuthentication {
  readonly store: ExecutionEngineProfileStore;
  readonly profile: ExecutionEngineProfile;
  readonly region?: KimiModelAuthentication["region"];
  readonly fetchImpl?: KimiModelAuthentication["fetchImpl"];
  readonly secretResolver?: SecretResolver;
}

export interface OwnedKimiExecutionOptions {
  readonly store: AcpJournaledLifecycleOptions["store"];
  readonly reservation: ReserveNativeExecutionInput;
  readonly configuration: AcpJournaledLifecycleOptions["configuration"];
  readonly input: readonly ContentBlock[];
  /** Host-prepared identity, not a renderer profile or proof of native acceptance. */
  readonly process: { readonly executablePath: string; readonly executableDigest: string;
    readonly kimiHome: string; readonly expectedVersion: string };
  /** Current Host Node/Electron boot identity; never native/model configuration. */
  readonly hostFileNode?: RestrictedCommandExecutablePin;
  readonly authentication?: KimiExecutionAuthentication;
  readonly approvalPolicy: Omit<KimiActionPreparationOptions, "cwd" | "sessionId" | "terminalShell">;
  readonly output: AcpJournaledLifecycleOptions["output"];
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onApprovalWaitChanged?: (waiting: boolean) => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
  readonly assertCurrentAuthority?: () => void;
  readonly signal: AbortSignal;
  readonly now?: () => string;
  readonly interruptGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly approvalPollIntervalMs?: number;
  readonly launch?: typeof spawn;
}

export class OwnedKimiExecutionError extends Error {
  constructor(readonly code: "invalid_execution" | "duplicate_execution") { super(code); }
}

/** Executes one existing Run/Attempt using the concrete Kimi policy, journal and owned native process. */
export async function executeOwnedKimiPrompt(request: OwnedKimiExecutionOptions) {
  const approvalPolicy = structuredClone(request.approvalPolicy);
  if (request.configuration.allowedTools !== undefined) {
    const excluded = Object.fromEntries([...readOnlyRunTools, ...riskyRunTools]
      .filter(tool => !request.configuration.allowedTools!.includes(tool)).map(tool => [tool, "deny" as const]));
    Object.assign(approvalPolicy, { policy: { ...approvalPolicy.policy,
      toolDecisions: { ...approvalPolicy.policy.toolDecisions, ...excluded } },
    ...(approvalPolicy.effectivePolicySnapshot ? { effectivePolicySnapshot: { ...approvalPolicy.effectivePolicySnapshot,
      toolDecisions: { ...approvalPolicy.effectivePolicySnapshot.toolDecisions, ...excluded } } } : {}) });
  }
  const options: OwnedKimiExecutionOptions = { ...request, reservation: structuredClone(request.reservation),
    configuration: structuredClone(request.configuration), input: structuredClone(request.input),
    process: structuredClone(request.process), hostFileNode: request.hostFileNode ? structuredClone(request.hostFileNode) : undefined, approvalPolicy,
    output: structuredClone(request.output), authentication: request.authentication ? { ...request.authentication,
      profile: structuredClone(request.authentication.profile) } : undefined };
  const grace = options.interruptGraceMs ?? 3000;
  const processInput = options.process;
  const target = { engineId: "kimi-acp" as const, expectedVersion: processInput.expectedVersion };
  const authentication = options.authentication;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 30_000
    || !isAbsolute(processInput.executablePath) || !isAbsolute(processInput.kimiHome)
    || !/^[a-f0-9]{64}$/.test(processInput.executableDigest)
    || options.reservation.selection.engineId !== target.engineId
    || options.reservation.selection.configurationFingerprint !== acpConfigurationFingerprint(target, options.configuration)
    || options.reservation.selection.modelId !== options.configuration.modelId) throw new OwnedKimiExecutionError("invalid_execution");
  let apiKey: string | undefined;
  let modelAuthentication: KimiModelAuthentication | undefined;
  const assertProfileCurrent = (): void => {
    if (!authentication) return;
    const { profile, store } = authentication, selection = options.reservation.selection;
    if (profile.configuration.engineId !== target.engineId || profile.configuration.executablePath !== processInput.executablePath
      || profile.id !== selection.profileId || profile.revision !== selection.profileRevision
      || profile.configurationFingerprint !== selection.profileFingerprint
      || store.getAuthProfileDirectory(profile) !== processInput.kimiHome) throw new OwnedKimiExecutionError("invalid_execution");
    if (profile.configuration.secretRef) {
      if (!profile.configuration.kimi || authentication.region !== undefined || !authentication.secretResolver) {
        throw new OwnedKimiExecutionError("invalid_execution");
      }
      const current = resolveEngineSecret(profile.configuration.secretRef, authentication.secretResolver);
      if (apiKey !== undefined && current !== apiKey) throw new EngineCredentialError("engine_secret_changed");
    } else {
      if (!authentication.region || profile.configuration.kimi || authentication.secretResolver
        || profile.configuration.kimiLoginRegion !== authentication.region) throw new OwnedKimiExecutionError("invalid_execution");
    }
  };
  assertProfileCurrent();
  if (authentication?.profile.configuration.secretRef) {
    apiKey = resolveEngineSecret(authentication.profile.configuration.secretRef, authentication.secretResolver);
  } else if (authentication) {
    modelAuthentication = { store: authentication.store, profile: authentication.profile, region: authentication.region!,
      ...(authentication.fetchImpl ? { fetchImpl: authentication.fetchImpl } : {}) };
  }
  const assertAuthenticationCurrent = async (): Promise<void> => {
    assertProfileCurrent();
    if (!authentication || !apiKey) return;
    await assertKimiApiKey(processInput.kimiHome, authentication.profile.configuration.kimi!, apiKey);
    assertProfileCurrent();
  };
  await assertAuthenticationCurrent();
  const secretRegistry = new NativeSecretRegistry([...(options.output.extraSecrets ?? []), ...(options.approvalPolicy.extraSecrets ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0));
  options.signal.throwIfAborted();
  const now = options.now ?? (() => new Date().toISOString());
  const executionAbort = new AbortController();
  let reserved: ReturnType<typeof options.store.reserveNativeExecution> | undefined;
  let lifecycle: AcpJournaledLifecycle | undefined;
  let handle: AcpPromptHandle | undefined;
  let root: string | undefined;
  let executionHome: Awaited<ReturnType<typeof prepareKimiExecutionHome>> | undefined;
  let nativeTerminal = false;
  let cancelTimer: NodeJS.Timeout | undefined;
  const assertOwned = (statuses: readonly NativeSubmission["status"][]): void => {
    options.signal.throwIfAborted(); executionAbort.signal.throwIfAborted(); assertProfileCurrent();
    const current = reserved && options.store.getNativeSubmission(reserved.submission.id);
    if (!current || !statuses.includes(current.status)) throw new OwnedKimiExecutionError("invalid_execution");
    const ownership = options.store.reserveNativeExecution(options.reservation, now());
    if (ownership.created || ownership.submission.id !== current.id) throw new OwnedKimiExecutionError("invalid_execution");
  };
  const abort = (): void => {
    if (nativeTerminal) return;
    if (!handle && (!reserved || options.store.getNativeSubmission(reserved.submission.id)?.status !== "accepted")) {
      executionAbort.abort(); return;
    }
    // Receipt can publish an approval before startPrompt returns its cancellable handle.
    cancelTimer ??= setTimeout(() => executionAbort.abort(), grace);
    if (handle) void handle.cancel().catch(() => executionAbort.abort());
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const events: RunEventEnvelope[] = [];
  const emit = (event: RunEventEnvelope): void => {
    const native = event.data.nativeOutput;
    if (native && typeof native === "object" && "terminal" in native && native.terminal) {
      nativeTerminal = true;
      clearTimeout(cancelTimer);
    }
    events.push(structuredClone(event));
    return options.onEvent(structuredClone(event));
  };
  try {
    if (options.signal.aborted) abort();
    const installed = await realpath(processInput.executablePath);
    const home = await realpath(processInput.kimiHome);
    if (home !== processInput.kimiHome || !(await stat(home)).isDirectory()) throw new OwnedKimiExecutionError("invalid_execution");
    await verifyKimiNativeExecutable(installed, processInput.executableDigest, executionAbort.signal);
    await assertAuthenticationCurrent();
    executionAbort.signal.throwIfAborted();
    reserved = options.store.reserveNativeExecution(options.reservation, now());
    if (!reserved.created) throw new OwnedKimiExecutionError("duplicate_execution");
    if (resolve(reserved.binding.cwd) !== resolve(options.configuration.cwd)) throw new OwnedKimiExecutionError("invalid_execution");
    root = await mkdtemp(join(tmpdir(), "ling-kimi-execution-"));
    root = await realpath(root);
    const executable = await prepareKimiNativeExecutable(installed, root, processInput.executableDigest, executionAbort.signal);
    const supervised = await prepareOwnedNativeSpawn(executable, processInput.executableDigest, options.launch);
    const policy = options.approvalPolicy.effectivePolicySnapshot;
    const readOnly = policy?.conversationMode === "plan" || policy?.workspaceAccessMode === "read_only"
      || options.configuration.modeId === "plan";
    executionHome = await prepareKimiExecutionHome(home, options.approvalPolicy, readOnly, executionAbort.signal, {
      allowedTools: options.configuration.allowedTools,
      modelId: options.configuration.modelId, modelSignal: AbortSignal.any([options.signal, executionAbort.signal]),
      authentication: modelAuthentication, secretRegistry, assertPreparationCurrent: () => assertOwned(["reserved"]),
      // Inference can precede the first ACP event that acknowledges this prompt.
      assertCurrent: () => assertOwned(["submission_pending", "accepted"]),
    });
    const launch = await preparePlatformNativeProcessLaunch({ executable, workspaceRoot: options.configuration.cwd,
      operationRoot: root, nativeHome: executionHome.home, persistentKimiHome: home,
      modelRelayPort: executionHome.modelRelayPort,
      policyProfileId: executionHome.readOnly ? "read_only" : "workspace_write",
      allowedWritePaths: policy?.allowedWritePaths ?? options.approvalPolicy.policy.allowedWritePaths }, supervised);
    const key = { submissionId: reserved.submission.id, fence: reserved.submission.fence };
    executionHome.assertUnchanged();
    assertOwned(["reserved"]);
    await assertAuthenticationCurrent();
    const delegateWrites = executionHome.enabledTools.some(tool => tool === "Write" || tool === "Edit");
    const delegateReads = delegateWrites || executionHome.enabledTools.includes("Read");
    const nativeTools = executionHome.enabledTools;
    // Match the pinned native environment probe on the supported POSIX boundary.
    const terminalShell = { executable: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find(existsSync) ?? "/bin/sh",
      platform: "posix" as const };
    let files: KimiHostFiles | undefined;
    const result = await withOwnedNativeProcess({ executable, root, launch, signal: executionAbort.signal, onLocalLifetime: options.onLocalLifetime, assertCurrentAuthority: options.assertCurrentAuthority,
      // Managed runs keep their execution snapshot fixed; native hot reload
      // would require an otherwise unnecessary filesystem event service.
      environment: { ...kimiNativeEnvironment(root, executionHome.home), KIMI_CODE_WATCH: "false" },
      args: ["acp"], maxOutputBytes: 128 * 1024 * 1024,
    }, async streams => {
      const extraSecrets = secretRegistry.getSnapshot();
      lifecycle = new AcpJournaledLifecycle({ store: options.store, key, target, configuration: options.configuration,
        assertCurrent: () => { assertProfileCurrent(); executionHome!.assertUnchanged(); },
        secretRegistry,
        createActions: binding => new KimiActionPreparer({ ...options.approvalPolicy, nativeTools, terminalShell, extraSecrets,
          cwd: options.configuration.cwd, sessionId: binding.sessionId }, secretRegistry),
        createHostFiles: delegateReads ? {
          readTextFile: context => files ??= new KimiHostFiles(context, { node: options.hostFileNode }),
          ...(delegateWrites ? { writeTextFile: context => (files ??= new KimiHostFiles(context, { node: options.hostFileNode })).writeTextFile } : {}),
        } : undefined,
        createHostTerminals: nativeTools.includes("Bash") ? context => new KimiHostTerminals(context, {
          workspaceRoot: options.configuration.cwd, policyProfileId: executionHome!.readOnly ? "read_only" : "workspace_write",
          allowedWritePaths: policy?.allowedWritePaths ?? options.approvalPolicy.policy.allowedWritePaths,
          assertUnchanged: () => { assertProfileCurrent(); executionHome!.assertUnchanged(); },
        }) : undefined,
        output: { ...options.output, extraSecrets },
        onEvent: emit, onApprovalWaitChanged: options.onApprovalWaitChanged,
        approvalPollIntervalMs: options.approvalPollIntervalMs, now,
        client: { ...streams, assertSubmissionCurrent: options.assertCurrentAuthority, onLocalLifetime: options.onLocalLifetime,
          requestTimeoutMs: options.requestTimeoutMs, turnTimeoutMs: options.turnTimeoutMs, cancelTimeoutMs: grace } });
      await lifecycle.open();
      streams.signal.throwIfAborted();
      executionHome!.assertUnchanged();
      assertOwned(["reserved"]);
      await assertAuthenticationCurrent();
      handle = await lifecycle.startPrompt(options.input);
      if (options.signal.aborted) abort();
      const completed = await handle.completed;
      nativeTerminal = true;
      clearTimeout(cancelTimer);
      return completed;
    });
    return { submissionId: reserved.submission.id, bindingId: reserved.binding.id,
      status: result.stopReason === "cancelled" ? "cancelled" as const : "completed" as const,
      stopReason: result.stopReason, events };
  } catch (error) {
    try { lifecycle?.close(); await lifecycle?.closed; }
    finally { if (reserved?.created) settleUnfinished(options, reserved.submission, now()); }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    clearTimeout(cancelTimer);
    try {
      try { lifecycle?.close(); }
      catch (error) {
        // A journal error cannot skip worker settlement or replace the original failure.
        try { await lifecycle?.closed; } finally { throw error; }
      }
      await lifecycle?.closed;
    }
    finally {
      try { await executionHome?.dispose(); }
      finally { if (root) await rm(root, { recursive: true, force: true }); }
    }
  }
}

function settleUnfinished(options: OwnedKimiExecutionOptions, submission: NativeSubmission, now: string): void {
  const current = options.store.getNativeSubmission(submission.id);
  const key = { submissionId: submission.id, fence: submission.fence };
  if (current?.status === "reserved") options.store.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now);
  else if (current && ["submission_pending", "accepted"].includes(current.status)) options.store.markNativeSubmissionUnknown(key, now);
}
