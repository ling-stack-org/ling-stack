import type { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type {
  ExecutionEngineProfileStore,
  NativeSubmission,
  ReserveNativeExecutionInput,
  RunEventEnvelope,
  SecretResolver,
} from "@ling-stack/core";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import { executableDigest } from "../../features/execution-engines/connection-probe.js";
import { resolveEngineSecret, EngineCredentialError } from "../../features/execution-engines/native-secrets.js";
import { openclawProcessEnvironment, writeOpenClawProbeCredential } from "../../features/execution-engines/openclaw-environment.js";
import { withOwnedNativeProcess } from "../../features/execution-engines/owned-native-process.js";
import { prepareOwnedNativeSpawn } from "../../features/execution-engines/windows-supervisor.js";
import { NativeSecretRegistry } from "../adapters/native-stream-redaction.js";
import { AcpJournaledLifecycle, acpConfigurationFingerprint, type AcpJournaledLifecycleOptions } from "./journaled-lifecycle.js";
import { OpenClawActionPreparer, type OpenClawActionPreparationOptions } from "./openclaw-action-preparation.js";
import type { AcpPromptHandle } from "./live-client.js";
import { record } from "./live-errors.js";

export interface OwnedOpenClawExecutionOptions {
  readonly store: AcpJournaledLifecycleOptions["store"];
  readonly reservation: ReserveNativeExecutionInput;
  readonly configuration: AcpJournaledLifecycleOptions["configuration"];
  readonly input: readonly ContentBlock[];
  readonly process: {
    readonly executablePath: string;
    readonly executableDigest: string;
    readonly expectedVersion: string;
  };
  readonly authentication: {
    readonly store: ExecutionEngineProfileStore;
    readonly profile: ExecutionEngineProfile;
    readonly secretResolver: SecretResolver;
  };
  readonly approvalPolicy: Omit<OpenClawActionPreparationOptions, "cwd" | "sessionId">;
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

export class OwnedOpenClawExecutionError extends Error {
  constructor(readonly code: "invalid_execution" | "duplicate_execution") { super(code); }
}

/** Executes one saved OpenClaw profile without owning or mutating its Gateway. */
export async function executeOwnedOpenClawPrompt(request: OwnedOpenClawExecutionOptions) {
  const options: OwnedOpenClawExecutionOptions = {
    ...request,
    reservation: structuredClone(request.reservation),
    configuration: structuredClone(request.configuration),
    input: structuredClone(request.input),
    process: structuredClone(request.process),
    authentication: { ...request.authentication, profile: structuredClone(request.authentication.profile) },
    approvalPolicy: structuredClone(request.approvalPolicy),
    output: structuredClone(request.output),
  };
  const grace = options.interruptGraceMs ?? 3000;
  const processInput = options.process;
  const authentication = options.authentication;
  const profile = authentication.profile;
  const remote = profile.configuration.openclaw;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 30_000
    || !isAbsolute(processInput.executablePath) || !/^[a-f0-9]{64}$/.test(processInput.executableDigest)
    || profile.configuration.engineId !== "openclaw-acp" || profile.configuration.executablePath !== processInput.executablePath
    || !profile.configuration.secretRef || !remote
    || options.reservation.selection.engineId !== "openclaw-acp"
    || options.reservation.selection.profileId !== profile.id
    || options.reservation.selection.profileRevision !== profile.revision
    || options.reservation.selection.profileFingerprint !== profile.configurationFingerprint
    || options.reservation.selection.modelId !== options.configuration.modelId) {
    throw new OwnedOpenClawExecutionError("invalid_execution");
  }
  const target = { engineId: "openclaw-acp" as const, expectedVersion: processInput.expectedVersion, agentId: remote.agentId };
  if (options.reservation.selection.configurationFingerprint !== acpConfigurationFingerprint(target, options.configuration)) {
    throw new OwnedOpenClawExecutionError("invalid_execution");
  }
  authentication.store.assertCurrentAuthProfile(profile);
  const secret = resolveEngineSecret(profile.configuration.secretRef, authentication.secretResolver);
  if (secret.length > 8192) throw new EngineCredentialError("engine_secret_invalid");
  const secretRegistry = new NativeSecretRegistry([secret,
    ...(options.output.extraSecrets ?? []), ...(options.approvalPolicy.extraSecrets ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0));
  options.signal.throwIfAborted();
  const executionAbort = new AbortController();
  const now = options.now ?? (() => new Date().toISOString());
  let reserved: ReturnType<typeof options.store.reserveNativeExecution> | undefined;
  let lifecycle: AcpJournaledLifecycle | undefined;
  let handle: AcpPromptHandle | undefined;
  let root: string | undefined;
  let source: { path: string; dev: number; ino: number; size: number; mtimeMs: number } | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;

  const assertProfileAndSecret = (): void => {
    authentication.store.assertCurrentAuthProfile(profile);
    if (resolveEngineSecret(profile.configuration.secretRef!, authentication.secretResolver) !== secret) {
      throw new EngineCredentialError("engine_secret_changed");
    }
  };
  const assertSourceCurrent = (): void => {
    if (!source) throw new OwnedOpenClawExecutionError("invalid_execution");
    let path: string;
    let current: ReturnType<typeof statSync>;
    try { path = realpathSync(processInput.executablePath); current = statSync(path); }
    catch { throw new OwnedOpenClawExecutionError("invalid_execution"); }
    if (path !== source.path || !current.isFile() || current.dev !== source.dev || current.ino !== source.ino
      || current.size !== source.size || current.mtimeMs !== source.mtimeMs) {
      throw new OwnedOpenClawExecutionError("invalid_execution");
    }
  };
  const assertStaticCurrent = (): void => { assertProfileAndSecret(); assertSourceCurrent(); };
  const assertResultCurrent = async (): Promise<void> => {
    assertStaticCurrent();
    if (await executableDigest(source!.path, executionAbort.signal) !== processInput.executableDigest) {
      throw new OwnedOpenClawExecutionError("invalid_execution");
    }
    assertStaticCurrent();
  };
  const assertOwned = (statuses: readonly NativeSubmission["status"][], committedOutput = false): void => {
    const current = reserved && options.store.getNativeSubmission(reserved.submission.id);
    // A user cancellation cannot retract an already committed result's remaining events.
    if (committedOutput && current?.status === "completed") {
      clearTimeout(cancelTimer); cancelTimer = undefined;
    } else options.signal.throwIfAborted();
    executionAbort.signal.throwIfAborted(); options.assertCurrentAuthority?.(); assertStaticCurrent();
    if (!current || !statuses.includes(current.status)) throw new OwnedOpenClawExecutionError("invalid_execution");
    const ownership = options.store.reserveNativeExecution(options.reservation, now());
    if (ownership.created || ownership.submission.id !== current.id) throw new OwnedOpenClawExecutionError("invalid_execution");
  };
  const abort = (): void => {
    const status = reserved && options.store.getNativeSubmission(reserved.submission.id)?.status;
    if (status === "completed") { clearTimeout(cancelTimer); cancelTimer = undefined; return; }
    if (!handle && status !== "accepted") {
      executionAbort.abort(); return;
    }
    cancelTimer ??= setTimeout(() => executionAbort.abort(), grace);
    if (handle) void handle.cancel().catch(() => executionAbort.abort());
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const events: RunEventEnvelope[] = [];
  const emit = (event: RunEventEnvelope): void => {
    const output = event.data.nativeOutput;
    const committed = record(output) && output.submissionId === reserved?.submission.id && output.terminal === "completed";
    assertOwned(["accepted", "completed"], committed);
    events.push(structuredClone(event));
    return options.onEvent(structuredClone(event));
  };

  try {
    if (options.signal.aborted) abort();
    const installed = await realpath(processInput.executablePath);
    const initial = await stat(installed);
    if (!initial.isFile() || await executableDigest(installed, executionAbort.signal) !== processInput.executableDigest) {
      throw new OwnedOpenClawExecutionError("invalid_execution");
    }
    source = { path: installed, dev: initial.dev, ino: initial.ino, size: initial.size, mtimeMs: initial.mtimeMs };
    assertStaticCurrent();
    reserved = options.store.reserveNativeExecution(options.reservation, now());
    if (!reserved.created) throw new OwnedOpenClawExecutionError("duplicate_execution");
    if (resolve(reserved.binding.cwd) !== resolve(options.configuration.cwd)) throw new OwnedOpenClawExecutionError("invalid_execution");
    root = await realpath(await mkdtemp(join(tmpdir(), "ling-openclaw-execution-")));
    const credentialFile = await writeOpenClawProbeCredential(root, secret);
    const launch = await prepareOwnedNativeSpawn(installed, processInput.executableDigest, options.launch);
    assertOwned(["reserved"]);
    const authOption = remote.credentialType === "password" ? "--password-file" : "--token-file";
    const result = await withOwnedNativeProcess({ executable: installed, root, launch, signal: executionAbort.signal, onLocalLifetime: options.onLocalLifetime, assertCurrentAuthority: options.assertCurrentAuthority,
      environment: openclawProcessEnvironment(root),
      args: ["acp", "--url", remote.gatewayUrl, authOption, credentialFile], maxOutputBytes: 128 * 1024 * 1024,
    }, async streams => {
      lifecycle = new AcpJournaledLifecycle({
        store: options.store,
        key: { submissionId: reserved!.submission.id, fence: reserved!.submission.fence },
        target,
        configuration: options.configuration,
        secretRegistry,
        createActions: binding => {
          const actions = new OpenClawActionPreparer({ ...options.approvalPolicy, cwd: options.configuration.cwd,
            sessionId: binding.sessionId, extraSecrets: secretRegistry.getSnapshot() });
          return {
            receive(update) { assertOwned(["accepted"]); actions.receive(update); },
            prepare(permission) { assertOwned(["accepted"]); return actions.prepare(permission); },
            clear() { actions.clear(); },
          };
        },
        output: { ...options.output, extraSecrets: secretRegistry.getSnapshot() },
        onEvent: emit,
        onApprovalWaitChanged: options.onApprovalWaitChanged,
        assertResultCurrent,
        approvalPollIntervalMs: options.approvalPollIntervalMs,
        now,
        client: { ...streams, assertSubmissionCurrent: options.assertCurrentAuthority, onLocalLifetime: options.onLocalLifetime,
          requestTimeoutMs: options.requestTimeoutMs, turnTimeoutMs: options.turnTimeoutMs,
          cancelTimeoutMs: grace },
      });
      await lifecycle.open();
      streams.signal.throwIfAborted();
      assertOwned(["reserved"]);
      handle = await lifecycle.startPrompt(options.input);
      if (options.signal.aborted) abort();
      return handle.completed;
    });
    clearTimeout(cancelTimer);
    return { submissionId: reserved.submission.id, bindingId: reserved.binding.id,
      status: "completed" as const, stopReason: result.stopReason, events };
  } catch (error) {
    try { lifecycle?.close(); await lifecycle?.closed; }
    finally { if (reserved?.created) settleUnfinished(options, reserved.submission, now()); }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    clearTimeout(cancelTimer);
    try {
      try { lifecycle?.close(); }
      catch (error) { try { await lifecycle?.closed; } finally { throw error; } }
      await lifecycle?.closed;
    } finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
}

function settleUnfinished(options: OwnedOpenClawExecutionOptions, submission: NativeSubmission, now: string): void {
  const current = options.store.getNativeSubmission(submission.id);
  const key = { submissionId: submission.id, fence: submission.fence };
  if (current?.status === "reserved") options.store.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now);
  else if (current && ["submission_pending", "accepted"].includes(current.status)) options.store.markNativeSubmissionUnknown(key, now);
}
