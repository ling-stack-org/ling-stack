import type { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import type { ExecutionEngineProfileStore, NativeSubmission, ReserveNativeExecutionInput, RunEventEnvelope, SecretResolver } from "@ling-stack/core";
import { assertCodexApiKey } from "../../../features/execution-engines/codex-auth-state.js";
import { executableDigest } from "../../../features/execution-engines/connection-probe.js";
import { EngineCredentialError, resolveEngineSecret } from "../../../features/execution-engines/native-secrets.js";
import { withOwnedNativeProcess } from "../../../features/execution-engines/owned-native-process.js";
import { prepareOwnedNativeSpawn } from "../../../features/execution-engines/windows-supervisor.js";
import { CodexJournaledLifecycle, codexConfigurationFingerprint, type CodexJournaledLifecycleOptions } from "./journaled-lifecycle.js";
import type { CodexTurnHandle, CodexTurnInput } from "./live-client.js";

export interface OwnedCodexExecutionOptions {
  readonly store: CodexJournaledLifecycleOptions["store"];
  readonly reservation: ReserveNativeExecutionInput;
  readonly configuration: CodexJournaledLifecycleOptions["configuration"];
  readonly input: CodexTurnInput;
  /** Trusted host-prepared identity. This entry neither resolves a profile nor certifies acceptance. */
  readonly process: { readonly executablePath: string; readonly executableDigest: string; readonly codexHome: string };
  readonly authentication: {
    readonly store: ExecutionEngineProfileStore;
    readonly profile: ExecutionEngineProfile;
    readonly secretResolver: SecretResolver;
  };
  readonly approvalPolicy: CodexJournaledLifecycleOptions["approvalPolicy"];
  readonly output: Omit<NonNullable<CodexJournaledLifecycleOptions["output"]>, "onEvent">;
  /** Synchronous notification of envelopes already committed in SQLite. */
  readonly onEvent: (event: RunEventEnvelope) => void;
  readonly onRequest?: CodexJournaledLifecycleOptions["client"]["onRequest"];
  readonly onApprovalWaitChanged?: (waiting: boolean) => void;
  readonly onLocalLifetime?: (lifetime: Promise<unknown>) => void;
  readonly assertCurrentAuthority?: () => void;
  readonly signal: AbortSignal;
  readonly now?: () => string;
  readonly interruptGraceMs?: number;
  readonly requestTimeoutMs?: number;
  readonly launch?: typeof spawn;
}

export class OwnedCodexExecutionError extends Error {
  constructor(readonly code: "invalid_execution" | "executable_changed" | "duplicate_execution" | "unsupported_request"
    | "native_execution_failed") { super(code); }
}

/** One already-created Ling Run/Attempt. No provider fallback or second workflow scheduler. */
export async function executeOwnedCodexTurn(request: OwnedCodexExecutionOptions) {
  const options: OwnedCodexExecutionOptions = { ...request,
    reservation: structuredClone(request.reservation), configuration: structuredClone(request.configuration),
    input: structuredClone(request.input), process: structuredClone(request.process),
    authentication: { ...request.authentication, profile: structuredClone(request.authentication.profile) },
    approvalPolicy: structuredClone(request.approvalPolicy), output: structuredClone(request.output) };
  const grace = options.interruptGraceMs ?? 3000;
  const processInput = options.process;
  const authentication = options.authentication;
  const profile = authentication.profile;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 30_000
    || !isAbsolute(processInput.executablePath) || !isAbsolute(processInput.codexHome)
    || !/^[a-f0-9]{64}$/.test(processInput.executableDigest)
    || profile.configuration.engineId !== "codex-app-server"
    || profile.configuration.executablePath !== processInput.executablePath
    || options.reservation.selection.engineId !== "codex-app-server"
    || options.reservation.selection.profileId !== profile.id
    || options.reservation.selection.profileRevision !== profile.revision
    || options.reservation.selection.profileFingerprint !== profile.configurationFingerprint
    || options.reservation.selection.modelId !== options.configuration.model
    || options.reservation.selection.configurationFingerprint !== codexConfigurationFingerprint(options.configuration)) {
    throw new OwnedCodexExecutionError("invalid_execution");
  }
  const assertProfileCurrent = (): void => {
    authentication.store.assertCurrentAuthProfile(profile);
    if (resolve(authentication.store.getAuthProfileDirectory(profile)) !== resolve(processInput.codexHome)) {
      throw new OwnedCodexExecutionError("invalid_execution");
    }
  };
  assertProfileCurrent();
  const secretRef = profile.configuration.secretRef;
  const secret = secretRef ? resolveEngineSecret(secretRef, authentication.secretResolver) : undefined;
  const assertAuthenticationCurrent = async (): Promise<void> => {
    assertProfileCurrent();
    if (!secretRef || secret === undefined) return;
    if (resolveEngineSecret(secretRef, authentication.secretResolver) !== secret) {
      throw new EngineCredentialError("engine_secret_changed");
    }
    await assertCodexApiKey(processInput.codexHome, secret);
    assertProfileCurrent();
    if (resolveEngineSecret(secretRef, authentication.secretResolver) !== secret) {
      throw new EngineCredentialError("engine_secret_changed");
    }
  };
  await assertAuthenticationCurrent();
  options.signal.throwIfAborted();
  const now = options.now ?? (() => new Date().toISOString());
  const executionAbort = new AbortController();
  let reserved: ReturnType<typeof options.store.reserveNativeExecution> | undefined;
  let handle: CodexTurnHandle | undefined;
  let nativeTerminal = false;
  let cancelTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    if (nativeTerminal) return;
    // Buffered approvals can reach the host before startTurn returns its accepted handle.
    if (!handle && (!reserved || options.store.getNativeSubmission(reserved.submission.id)?.status !== "accepted")) {
      executionAbort.abort(); return;
    }
    cancelTimer ??= setTimeout(() => executionAbort.abort(), grace);
    if (handle) void handle.interrupt().catch(() => executionAbort.abort());
  };
  options.signal.addEventListener("abort", abort, { once: true });
  let lifecycle: CodexJournaledLifecycle | undefined;
  let root: string | undefined;
  const events: RunEventEnvelope[] = [];
  const emit = (event: RunEventEnvelope): void => {
    assertProfileCurrent();
    const native = event.data.nativeOutput;
    if (native && typeof native === "object" && "terminal" in native && native.terminal) {
      nativeTerminal = true;
      clearTimeout(cancelTimer);
    }
    events.push(structuredClone(event));
    options.onEvent(structuredClone(event));
  };
  try {
    if (options.signal.aborted) abort();
    const executable = await realpath(processInput.executablePath);
    const home = await realpath(processInput.codexHome);
    if (!(await stat(home)).isDirectory() || home !== processInput.codexHome) throw new OwnedCodexExecutionError("invalid_execution");
    if (await executableDigest(executable, executionAbort.signal) !== processInput.executableDigest) throw new OwnedCodexExecutionError("executable_changed");
    await assertAuthenticationCurrent();
    executionAbort.signal.throwIfAborted();
    reserved = options.store.reserveNativeExecution(structuredClone(options.reservation), now());
    if (!reserved.created) throw new OwnedCodexExecutionError("duplicate_execution");
    root = await mkdtemp(join(tmpdir(), "ling-codex-execution-"));
    const launch = await prepareOwnedNativeSpawn(executable, processInput.executableDigest, options.launch);
    await assertAuthenticationCurrent();
    const key = { submissionId: reserved.submission.id, fence: reserved.submission.fence };
    const result = await withOwnedNativeProcess({ executable, root, launch, signal: executionAbort.signal, onLocalLifetime: options.onLocalLifetime, assertCurrentAuthority: options.assertCurrentAuthority,
      environment: { CODEX_HOME: home }, maxOutputBytes: 128 * 1024 * 1024,
      args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"', "-c", "check_for_update_on_startup=false"],
    }, async streams => {
      lifecycle = new CodexJournaledLifecycle({ store: options.store, key,
        configuration: options.configuration, approvalPolicy: options.approvalPolicy, now,
        output: { ...options.output, onEvent: emit },
        approvalWait: { onEvent: emit, onWaitChanged: options.onApprovalWaitChanged },
        client: { ...streams, assertSubmissionCurrent: options.assertCurrentAuthority, codexHome: home, requestTimeoutMs: options.requestTimeoutMs, onLocalLifetime: options.onLocalLifetime,
          beforeEvent: async () => { await assertAuthenticationCurrent(); },
          beforeRequest: async () => { await assertAuthenticationCurrent(); },
          onEvent: async () => { await assertAuthenticationCurrent(); },
          onRequest: async (...args) => {
            await assertAuthenticationCurrent();
            if (!options.onRequest) throw new OwnedCodexExecutionError("unsupported_request");
            return options.onRequest(...args);
          } } });
      await lifecycle.open();
      streams.signal.throwIfAborted();
      handle = await lifecycle.startTurn(structuredClone(options.input));
      if (options.signal.aborted) abort();
      const completed = await handle.completed;
      nativeTerminal = true;
      clearTimeout(cancelTimer);
      return completed;
    });
    if (result.status === "failed") throw new OwnedCodexExecutionError("native_execution_failed");
    if (result.status === "inProgress") throw new OwnedCodexExecutionError("invalid_execution");
    return { submissionId: reserved.submission.id, bindingId: reserved.binding.id,
      status: result.status === "interrupted" ? "cancelled" as const : result.status, events };
  } catch (error) {
    if (reserved?.created) settleUnfinished(options, reserved.submission, now());
    throw error;
  } finally {
    options.signal.removeEventListener("abort", abort);
    clearTimeout(cancelTimer);
    try { lifecycle?.close(); }
    finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
}

function settleUnfinished(options: OwnedCodexExecutionOptions, submission: NativeSubmission, now: string): void {
  const current = options.store.getNativeSubmission(submission.id);
  const key = { submissionId: submission.id, fence: submission.fence };
  if (current?.status === "reserved") options.store.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now);
  else if (current && ["submission_pending", "accepted"].includes(current.status)) options.store.markNativeSubmissionUnknown(key, now);
}
