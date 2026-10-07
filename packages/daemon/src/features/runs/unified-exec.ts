import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  redactSecrets,
  type ArtifactType,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventEmitter,
  type RunSession,
  type RunStore,
  type RuntimeAttemptFenceV1,
  type UnifiedExecArtifactSummary,
  type UnifiedExecCommand,
  type UnifiedExecEnvironmentPolicy,
  type UnifiedExecEnvironmentSummary,
  type UnifiedExecRequest,
  type UnifiedExecProcessObservation,
  type UnifiedExecResult,
  type UnifiedExecStatus,
  type UnifiedExecIsolationEvidence,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { normalizeArtifactPath } from "../../shared/path.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord } from "../../shared/validation.js";
import { createShellSnapshotWriter } from "./shell-snapshots.js";
import { renderUnifiedExecModelOutput } from "./unified-exec-model-output.js";
import { observeCommandProcess } from "./unified-exec-process.js";
import type { NativeRestrictedCommandRuntime } from "../../runtime/sandbox/restricted-command-runtime.js";
import { createRestrictedCommandDispatch } from "./restricted-command-dispatch.js";
import { workflowOperationEffectRejection } from "./workflow-operation-effect-gate.js";
import { validateWorkflowOperationRunContext } from "./workflow-operation-snapshot.js";
import { createStreamCapture, createSyntheticStreamCapture, toStreamSummary, type StreamCaptureSnapshot } from "./unified-exec-output.js";
import type { HostCommandOperation } from "../../runtime/host-operation-effects.js";
import { createUnifiedExecRawDispatch } from "./unified-exec-raw-source.js";
import { normalizeBashRequest } from "./unified-exec-request.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export async function executeUnifiedBashTool(input: {
  readonly restrictedCommandRuntime?: NativeRestrictedCommandRuntime;
  readonly store: RunStore;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly approvalId?: string;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
  /** Called only after the bounded result and output artifacts are durable. */
  readonly onDurableResult?: (result: PiRunnerToolHandledResult) => void;
  readonly hostOperation?: HostCommandOperation;
}): Promise<PiRunnerToolHandledResult> {
  let delegated = false;
  try {
    input.hostOperation?.assertMayPrepare();
    const normalized = normalizeBashRequest(input.run, input.request, input.approvalId);
    if ("error" in normalized) {
      return writeSyntheticFailureResult({
        ...input,
        request: normalized.request,
        message: normalized.error,
        status: "failed",
      });
    }
    const rejection = validateWorkflowOperationRunContext(input).status === "legacy"
      ? undefined : workflowOperationEffectRejection(input);
    if (rejection) return createUnifiedExecDeniedResult({ toolCallId: input.request.toolCallId,
      approvalId: input.approvalId, reason: rejection.code + ": " + rejection.reason });
    let restrictedDispatch: ReturnType<typeof createRestrictedCommandDispatch>;
    let rawDispatch: ReturnType<typeof createUnifiedExecRawDispatch> | undefined;
    try { restrictedDispatch = createRestrictedCommandDispatch(input); }
    catch (error) { return createUnifiedExecDeniedResult({ toolCallId: input.request.toolCallId,
      approvalId: input.approvalId, reason: formatError(error) }); }
    if (restrictedDispatch === undefined) {
      try { rawDispatch = createUnifiedExecRawDispatch({ ...input,
        approvalRequest: input.request, request: normalized.request }); }
      catch (error) {
        // A cancellation is control flow, not a policy-denied handled result.
        throwIfAborted(input.signal);
        return createUnifiedExecDeniedResult({ toolCallId: input.request.toolCallId,
          approvalId: input.approvalId, reason: formatError(error) });
      }
    }
    delegated = true;
    return await executeUnifiedExec({
      ...input,
      restrictedDispatch,
      rawDispatch,
      request: normalized.request,
    });
  } finally {
    // Before internal command preparation there has been no OS/native producer
    // dispatch. Early denial/invalid input is a real instrumented no-start.
    if (!delegated && input.hostOperation) {
      try { input.hostOperation.settleNoStart(); }
      catch (error) {
        input.hostOperation.markUnknown("command_pre_dispatch_unconfirmed");
        throw error;
      }
    }
  }
}

export function createUnifiedExecDeniedResult(input: {
  readonly toolCallId: string;
  readonly approvalId?: string;
  readonly reason?: string;
}): PiRunnerToolHandledResult {
  const reason = input.reason ?? "Ling Stack policy denied bash.";
  return {
    content: [{ type: "text", text: reason }],
    details: {
      unifiedExec: {
        status: "failed",
        toolCallId: input.toolCallId,
        approvalId: input.approvalId,
        denied: true,
        reason,
      },
    },
    isError: true,
  };
}

async function executeUnifiedExec(input: {
  readonly restrictedDispatch?: ReturnType<typeof createRestrictedCommandDispatch>;
  readonly rawDispatch?: ReturnType<typeof createUnifiedExecRawDispatch>;
  readonly store: RunStore;
  readonly sourceFence: RuntimeAttemptFenceV1;
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
  readonly onDurableResult?: (result: PiRunnerToolHandledResult) => void;
  readonly hostOperation?: HostCommandOperation;
}): Promise<PiRunnerToolHandledResult> {
  const secrets = input.extraSecrets ?? [];
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let environment = buildEnvironment(input.request.cwd, input.request.environment);
  let prepared: (Awaited<ReturnType<NativeRestrictedCommandRuntime["prepare"]>> & {
    readonly finishHostPreparation?: () => void;
  }) | undefined;
  let cleanupSafe = false;
  let ticket: ReturnType<RunStore["prepareHostCommandExecution"]> | undefined;
  let preparationAttempted = false;
  let spawnEntered = false;
  let noStartSettled = false;
  let commandPreparationAttempted = false;
  try {
    throwIfAborted(input.signal);
    input.hostOperation?.assertMayPrepare();
    commandPreparationAttempted = true;
    ticket = input.store.prepareHostCommandExecution({
      runId: input.run.id, sourceFence: input.sourceFence, toolCallId: input.request.toolCallId,
      cwd: input.request.cwd, command: input.request.command,
    });
    input.hostOperation?.bindCommandExecution(ticket.executionId);
    try {
      preparationAttempted = input.restrictedDispatch !== undefined;
      prepared = await input.restrictedDispatch?.prepare();
      if (prepared) environment = { env: {}, summary: prepared.environmentSummary };
    } catch (error) {
      input.store.settleHostCommandExecution(ticket, { kind: "not_started" });
      noStartSettled = true;
      cleanupSafe = true;
      throwIfAborted(input.signal);
      return writeSyntheticFailureResult({ ...input, message: formatError(error), status: "failed",
        environmentSummary: environment.summary, startedAt, startedMs });
    }
  const stdout = createStreamCapture("stdout", input.request.toolCallId, input.appendAndMaybeStream, secrets);
  const stderr = createStreamCapture("stderr", input.request.toolCallId, input.appendAndMaybeStream, secrets);
  const shellSnapshots = createShellSnapshotWriter({
    enabled: input.shellSnapshotEnabled === true,
    store: input.store,
    run: input.run,
    request: input.request,
    environmentSummary: environment.summary,
    appendAndMaybeStream: (type, data) => input.appendAndMaybeStream(type, data),
    extraSecrets: input.extraSecrets,
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  let launchFailed = false;
  let launchError: unknown;
  try {
    shellSnapshots.captureStart({ startedAt, startedMs });
    const launch = () => {
      throwIfAborted(input.signal);
      if (prepared) {
        // Native preparation has its own enrolled physical effects. Keep its
        // existing conservative latch; it is not authority for a raw producer.
        spawnEntered = true;
        child = prepared.spawn();
      } else {
        if (!input.rawDispatch) throw new Error("unified_exec_raw_source_missing");
        child = input.rawDispatch.spawn(environment.env, () => { spawnEntered = true; });
      }
    };
    const preflight = () => {
      throwIfAborted(input.signal);
      input.restrictedDispatch?.assertMayLaunch();
      input.rawDispatch?.assertMayLaunch();
    };
    if (input.hostOperation) input.hostOperation.launch(ticket, launch, preflight);
    else input.store.launchHostCommandExecution(ticket, launch, preflight);
  } catch (error) {
    if (child) {
      // An OS process exists even if the database commit failed. Do not call it not_started.
      launchFailed = true;
      launchError = error;
    } else {
      // An entered native producer can throw before returning a child. No
      // handle is not proof that no process/effect exists.
      if (spawnEntered) {
        input.store.settleHostCommandExecution(ticket, { kind: "observed", observation: {
          scope: process.platform === "win32" ? "leader" : "process_group", settledBy: "cleanup_deadline",
          leaderExited: false, stdioClosed: false, descendants: "unverified", stopReason: "observer_error", signalFailures: [],
        } });
      } else {
        input.store.settleHostCommandExecution(ticket, { kind: "not_started" });
        noStartSettled = true;
        cleanupSafe = true;
      }
      throwIfAborted(input.signal);
      const handled = writeSyntheticFailureResult({
        ...input,
        message: `Ling Stack unified exec failed to spawn bash: ${formatError(error)}`,
        status: "failed",
        environmentSummary: environment.summary,
        startedAt,
        startedMs,
      });
      shellSnapshots.captureEnd(readUnifiedExecResult(handled));
      return handled;
    }
  }
  if (!child) throw new Error("Host command launcher returned without a process.");
  const processResult = await observeCommandProcess({
    child, signal: launchFailed ? AbortSignal.abort(launchError) : input.signal,
    timeoutMs: input.request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    idleTimeoutMs: input.request.idleTimeoutMs,
    onOutput: (stream, chunk) => (stream === "stdout" ? stdout : stderr).ingest(chunk),
  });
  const observed = launchFailed ? { ...processResult,
    observation: { ...processResult.observation, stopReason: "observer_error" as const },
    error: launchError instanceof Error ? launchError : new Error(formatError(launchError)),
  } : processResult;
  const { observation: processObservation, exitCode, signal: processSignal } = observed;
  cleanupSafe = processObservation.settledBy === "close" && processObservation.leaderExited
    && processObservation.stdioClosed && !processObservation.stopReason && processObservation.signalFailures.length === 0;
  // Persist independently of Runner/SSE callbacks: cancellation closes those channels.
  // Do this before flushing output or writing artifacts, either of which can throw.
  input.store.settleHostCommandExecution(ticket,
    processObservation.settledBy === "spawn_error" && child.pid === undefined
      ? { kind: "not_started" }
      : { kind: "observed", observation: input.signal?.aborted && !processObservation.stopReason
        ? { ...processObservation, stopReason: "cancelled" } : processObservation });
  const cancelled = processObservation.stopReason === "cancelled";
  const timedOut = processObservation.stopReason === "timeout";
  if (observed.error) stderr.ingest(Buffer.from(`Ling Stack unified exec process error: ${formatError(observed.error)}\n`));
  stdout.flush();
  stderr.flush();

  const outputIncomplete = processObservation.settledBy === "cleanup_deadline" && !processObservation.stdioClosed;
  const stdoutSnapshot = outputIncomplete
    ? { ...stdout.snapshot(), previewTruncated: true, artifactTruncated: true } : stdout.snapshot();
  const stderrSnapshot = outputIncomplete
    ? { ...stderr.snapshot(), previewTruncated: true, artifactTruncated: true } : stderr.snapshot();

  if (cancelled || input.signal?.aborted) {
    const handled = writeUnifiedExecResult({
      ...input,
      environmentSummary: environment.summary,
      startedAt,
      startedMs,
      exitCode,
      signal: processSignal,
      timedOut,
      cancelled: true,
      status: "cancelled",
      processObservation,
      isolation: prepared?.evidence,
      stdout: stdoutSnapshot,
      stderr: stderrSnapshot,
    });
    shellSnapshots.captureEnd(readUnifiedExecResult(handled));
    input.onDurableResult?.(handled);
    throw createAbortError();
  }

  const status: UnifiedExecStatus = timedOut
    ? "timed_out"
    : exitCode === 0 && !observed.error && !processObservation.stopReason
      ? "succeeded"
      : "failed";
  const handled = writeUnifiedExecResult({
    ...input,
    environmentSummary: environment.summary,
    startedAt,
    startedMs,
    exitCode,
    signal: processSignal,
    timedOut,
    cancelled,
    status,
    processObservation,
    isolation: prepared?.evidence,
    stdout: stdoutSnapshot,
    stderr: stderrSnapshot,
  });
  shellSnapshots.captureEnd(readUnifiedExecResult(handled));
  input.onDurableResult?.(handled);
  return handled;
  } finally {
    // Unknown descendants may still be running. Retain their isolated files for
    // inspection, alongside the journal's stop_unconfirmed reservation.
    try {
      if (cleanupSafe) prepared?.dispose();
    } finally {
      try { prepared?.finishHostPreparation?.(); }
      finally {
        if (input.hostOperation) {
          // A returned command result, clean leader close, cancellation or
          // native preparation callback cannot prove the whole physical scope.
          if (spawnEntered || preparationAttempted || (commandPreparationAttempted && !noStartSettled)) {
            input.hostOperation.markUnknown("command_physical_scope_unverified");
          } else {
            try { input.hostOperation.settleNoStart(); }
            catch (error) {
              input.hostOperation.markUnknown("command_preparation_unconfirmed");
              throw error;
            }
          }
        }
      }
    }
  }
}

function writeSyntheticFailureResult(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly message: string;
  readonly status: UnifiedExecStatus;
  readonly environmentSummary?: UnifiedExecEnvironmentSummary;
  readonly startedAt?: string;
  readonly startedMs?: number;
  readonly onDurableResult?: (result: PiRunnerToolHandledResult) => void;
}): PiRunnerToolHandledResult {
  const secrets = input.extraSecrets ?? [];
  const startedAt = input.startedAt ?? new Date().toISOString();
  const startedMs = input.startedMs ?? Date.now();
  const stderr = createSyntheticStreamCapture(input.message, secrets);
  const handled = writeUnifiedExecResult({
    store: input.store,
    run: input.run,
    request: input.request,
    appendAndMaybeStream: input.appendAndMaybeStream,
    extraSecrets: input.extraSecrets,
    environmentSummary: input.environmentSummary ?? buildEnvironment(input.request.cwd, input.request.environment).summary,
    startedAt,
    startedMs,
    exitCode: undefined,
    signal: undefined,
    timedOut: false,
    cancelled: false,
    status: input.status,
    stdout: createSyntheticStreamCapture("", secrets),
    stderr,
  });
  input.onDurableResult?.(handled);
  return handled;
}

function writeUnifiedExecResult(input: {
  readonly isolation?: UnifiedExecIsolationEvidence;
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
  readonly startedAt: string;
  readonly startedMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly processObservation?: UnifiedExecProcessObservation;
  readonly status: UnifiedExecStatus;
  readonly stdout: StreamCaptureSnapshot;
  readonly stderr: StreamCaptureSnapshot;
}): PiRunnerToolHandledResult {
  const now = new Date().toISOString();
  const stdoutSummary = toStreamSummary(input.stdout);
  const stderrSummary = toStreamSummary(input.stderr);
  const outputArtifactSummaries: UnifiedExecArtifactSummary[] = [];
  if (input.stdout.artifactContent.length > 0) {
    const artifact = writeExecArtifact({
      store: input.store,
      run: input.run,
      toolCallId: input.request.toolCallId,
      role: "stdout",
      filename: "stdout.txt",
      type: "log",
      title: "Unified exec stdout",
      contentType: "text/plain; charset=utf-8",
      content: input.stdout.artifactContent,
      now,
    });
    stdoutSummary.artifactId = artifact.id;
    outputArtifactSummaries.push(toArtifactSummary(artifact, "stdout", input.stdout.redacted, input.stdout.artifactTruncated));
  }
  if (input.stderr.artifactContent.length > 0) {
    const artifact = writeExecArtifact({
      store: input.store,
      run: input.run,
      toolCallId: input.request.toolCallId,
      role: "stderr",
      filename: "stderr.txt",
      type: "log",
      title: "Unified exec stderr",
      contentType: "text/plain; charset=utf-8",
      content: input.stderr.artifactContent,
      now,
    });
    stderrSummary.artifactId = artifact.id;
    outputArtifactSummaries.push(toArtifactSummary(artifact, "stderr", input.stderr.redacted, input.stderr.artifactTruncated));
  }

  const endedAt = now;
  const actualCommandSecrets = input.isolation?.actualCommand.kind === "argv"
    ? [input.isolation.actualCommand.argv[0]]
    : [];
  const publishedSecrets = [...input.extraSecrets ?? [], ...actualCommandSecrets];
  const baseResult = {
    status: input.status,
    runId: input.run.id,
    taskId: input.run.taskId,
    toolCallId: input.request.toolCallId,
    approvalId: input.request.approvalId,
    cwd: input.request.cwd,
    command: redactCommand(input.request.command, input.extraSecrets ?? []),
    environmentSummary: input.environmentSummary,
    startedAt: input.startedAt,
    endedAt,
    durationMs: Math.max(0, Date.now() - input.startedMs),
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    cancelled: input.cancelled,
    processObservation: input.processObservation,
    ...(input.isolation ? { isolation: { ...input.isolation,
      actualCommand: redactCommand(input.isolation.actualCommand, publishedSecrets) } } : {}),
    stdout: stdoutSummary,
    stderr: stderrSummary,
  };

  const resultArtifactId = artifactIdFor(input.run.id, input.request.toolCallId, "result");
  let resultArtifacts: UnifiedExecArtifactSummary[] = [
    {
      artifactId: resultArtifactId,
      role: "result",
      contentType: "application/json",
      sizeBytes: 0,
      redacted: wasCommandRedacted(input.request.command, input.extraSecrets ?? [])
        || (input.isolation ? wasCommandRedacted(input.isolation.actualCommand, publishedSecrets) : false)
        || input.stdout.redacted || input.stderr.redacted,
      truncated: false,
    },
    ...outputArtifactSummaries,
  ];
  let result: UnifiedExecResult = { ...baseResult, artifacts: resultArtifacts };
  let resultContent = "";
  for (let index = 0; index < 6; index += 1) {
    result = { ...baseResult, artifacts: resultArtifacts };
    resultContent = `${JSON.stringify(redactSecrets(result, input.extraSecrets ?? []), null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(resultContent, "utf8");
    if (resultArtifacts[0]?.sizeBytes === sizeBytes) {
      break;
    }
    resultArtifacts = [{ ...resultArtifacts[0], sizeBytes }, ...outputArtifactSummaries];
  }
  result = { ...baseResult, artifacts: resultArtifacts };
  const resultArtifact = writeExecArtifact({
    store: input.store,
    run: input.run,
    toolCallId: input.request.toolCallId,
    role: "result",
    filename: "result.json",
    type: "json",
    title: "Unified exec result",
    contentType: "application/json",
    content: resultContent,
    now,
    artifactId: resultArtifactId,
  });
  appendExecArtifactEvents({
    artifacts: [
      { artifact: resultArtifact, role: "result" },
      ...outputArtifactSummaries.map((summary) => ({
        artifact: input.store.getArtifact(summary.artifactId),
        role: summary.role,
      })).filter((entry): entry is { readonly artifact: RunArtifact; readonly role: "stdout" | "stderr" } => Boolean(entry.artifact)),
    ],
    toolCallId: input.request.toolCallId,
    appendAndMaybeStream: input.appendAndMaybeStream,
  });

  return {
    content: [{ type: "text", text: redactTextWithSecrets(renderUnifiedExecModelOutput(result), input.extraSecrets ?? []) }],
    details: { unifiedExec: result },
    isError: result.status !== "succeeded",
  };
}

function writeExecArtifact(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly toolCallId: string;
  readonly role: "result" | "stdout" | "stderr";
  readonly filename: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType: string;
  readonly content: string;
  readonly now: string;
  readonly artifactId?: string;
}): RunArtifact {
  const safeToolCallId = sanitizePathSegment(input.toolCallId);
  const relativePath = normalizeArtifactPath(`${input.run.id}/unified-exec/${safeToolCallId}/${input.filename}`);
  const absolutePath = resolvePath(input.store.paths.artifactsDir, relativePath);
  const relativeToRoot = relative(input.store.paths.artifactsDir, absolutePath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Unified exec artifact path escaped artifact root: ${relativePath}`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.content, "utf8");
  const stats = statSync(absolutePath);
  return input.store.createArtifact({
    id: input.artifactId,
    runId: input.run.id,
    type: input.type,
    path: relativePath,
    title: input.title,
    contentType: input.contentType,
    sizeBytes: Number(stats.size),
    createdAt: input.now,
  });
}

function appendExecArtifactEvents(input: {
  readonly artifacts: readonly { readonly artifact: RunArtifact; readonly role: "result" | "stdout" | "stderr" }[];
  readonly toolCallId: string;
  readonly appendAndMaybeStream: RunEventEmitter;
}): void {
  for (const item of input.artifacts) {
    input.appendAndMaybeStream("artifact_created", {
      artifact: item.artifact,
      artifactId: item.artifact.id,
      toolCallId: input.toolCallId,
      toolName: "bash",
      role: item.role,
    });
  }
}

function toArtifactSummary(
  artifact: RunArtifact,
  role: "result" | "stdout" | "stderr",
  redacted: boolean,
  truncated: boolean,
): UnifiedExecArtifactSummary {
  return {
    artifactId: artifact.id,
    role,
    contentType: artifact.contentType ?? "application/octet-stream",
    sizeBytes: artifact.sizeBytes ?? 0,
    redacted,
    truncated,
  };
}

function buildEnvironment(cwd: string, policy: UnifiedExecEnvironmentPolicy | undefined): {
  readonly env: NodeJS.ProcessEnv;
  readonly summary: UnifiedExecEnvironmentSummary;
} {
  const env: NodeJS.ProcessEnv = {};
  const source = process.env;
  const inheritedKeys = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL"];
  for (const key of inheritedKeys) {
    if (source[key] !== undefined) {
      env[key] = source[key];
    }
  }
  env.LING_STACK_RUN_TOOL = "bash";
  const keys = Object.keys(env).sort();
  return {
    env,
    summary: {
      mode: policy?.mode ?? "inherit_minimal",
      cwd,
      keys,
      redactedKeys: [],
      pathEntryCount: env.PATH ? env.PATH.split(":").filter(Boolean).length : undefined,
    },
  };
}

function redactCommand(command: UnifiedExecCommand, extraSecrets: readonly (string | undefined)[]): UnifiedExecCommand {
  if (command.kind === "argv") {
    return {
      ...command,
      argv: command.argv.map((value) => redactTextWithSecrets(value, extraSecrets)),
    };
  }
  return {
    ...command,
    command: redactTextWithSecrets(command.command, extraSecrets),
  };
}

function wasCommandRedacted(command: UnifiedExecCommand, extraSecrets: readonly (string | undefined)[]): boolean {
  return JSON.stringify(command) !== JSON.stringify(redactCommand(command, extraSecrets));
}

function artifactIdFor(runId: string, toolCallId: string, role: string): string {
  return `artifact_${sanitizeId(runId)}_${sanitizeId(toolCallId)}_unified_exec_${role}`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "tool";
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_") || "id";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readUnifiedExecResult(result: PiRunnerToolHandledResult): UnifiedExecResult {
  const details = result.details;
  if (!isRecord(details) || !isRecord(details.unifiedExec)) {
    throw new Error("Unified exec handled result did not include result details.");
  }
  return details.unifiedExec as unknown as UnifiedExecResult;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}
