import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  type UnifiedExecArtifactSummary,
  type UnifiedExecCommand,
  type UnifiedExecEnvironmentPolicy,
  type UnifiedExecEnvironmentSummary,
  type UnifiedExecOutputChunk,
  type UnifiedExecRequest,
  type UnifiedExecResult,
  type UnifiedExecStatus,
  type UnifiedExecStreamSummary,
} from "@ling-stack/core";
import type { PiRunnerApprovalRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { normalizeArtifactPath } from "../../shared/path.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { isRecord } from "../../shared/validation.js";
import { createShellSnapshotWriter } from "./shell-snapshots.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const STREAM_PREVIEW_BYTES = 8 * 1024;
const OUTPUT_CHUNK_BYTES = 4 * 1024;
const ARTIFACT_BYTES = 2 * 1024 * 1024;
const REDACTION_CARRY_CHARS = 256;

export async function executeUnifiedBashTool(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: PiRunnerApprovalRequest;
  readonly approvalId?: string;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
}): Promise<PiRunnerToolHandledResult> {
  const normalized = normalizeBashRequest(input.run, input.request, input.approvalId);
  if ("error" in normalized) {
    return writeSyntheticFailureResult({
      ...input,
      request: normalized.request,
      message: normalized.error,
      status: "failed",
    });
  }
  return executeUnifiedExec({
    ...input,
    request: normalized.request,
  });
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

function normalizeBashRequest(
  run: RunSession,
  approvalRequest: PiRunnerApprovalRequest,
  approvalId: string | undefined,
): { readonly request: UnifiedExecRequest } | { readonly request: UnifiedExecRequest; readonly error: string } {
  const command = readInputString(approvalRequest.input, "command", "");
  const requestedCwd = readInputString(approvalRequest.input, "cwd", approvalRequest.cwd || run.cwd);
  const cwd = isAbsolute(requestedCwd) ? resolvePath(requestedCwd) : resolvePath(run.cwd, requestedCwd);
  const timeoutMs = readTimeoutMs(approvalRequest.input);
  const idleTimeoutMs = readInputNumber(approvalRequest.input, "idleTimeoutMs");
  const pty = readInputBoolean(approvalRequest.input, "pty") ?? false;
  const request: UnifiedExecRequest = {
    runId: run.id,
    taskId: run.taskId,
    toolCallId: approvalRequest.toolCallId,
    approvalId,
    cwd,
    command: { kind: "shell", command, shell: "bash" },
    timeoutMs,
    idleTimeoutMs,
    pty,
    environment: { mode: "inherit_minimal" },
    startedBy: "run_tool",
  };
  if (!command.trim()) {
    return { request, error: "Ling Stack unified exec rejected an empty bash command." };
  }
  if (pty) {
    return { request, error: "Ling Stack unified exec P1 does not support PTY shell commands." };
  }
  if (!isPathInsideRoot(run.cwd, cwd)) {
    return { request, error: `Ling Stack unified exec rejected cwd outside the run workspace: ${cwd}` };
  }
  return { request };
}

async function executeUnifiedExec(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly appendAndMaybeStream: RunEventEmitter;
  readonly signal?: AbortSignal;
  readonly extraSecrets?: readonly (string | undefined)[];
  readonly shellSnapshotEnabled?: boolean;
}): Promise<PiRunnerToolHandledResult> {
  throwIfAborted(input.signal);
  const secrets = input.extraSecrets ?? [];
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const environment = buildEnvironment(input.request.cwd, input.request.environment);
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
  let timedOut = false;
  let cancelled = false;
  let processSignal: string | undefined;
  let exitCode: number | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  shellSnapshots.captureStart({ startedAt, startedMs });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnCommand(input.request.command, {
      cwd: input.request.cwd,
      env: environment.env,
    });
  } catch (error) {
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

  const killChild = (reason: "timeout" | "cancelled"): void => {
    if (reason === "timeout") {
      timedOut = true;
    } else {
      cancelled = true;
    }
    terminateProcessTree(child, "SIGTERM");
    killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), 500);
    if (typeof killTimer.unref === "function") {
      killTimer.unref();
    }
  };

  const abortListener = (): void => {
    killChild("cancelled");
  };
  input.signal?.addEventListener("abort", abortListener, { once: true });

  const timeoutMs = input.request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    killChild("timeout");
  }, timeoutMs);
  if (typeof timeoutTimer.unref === "function") {
    timeoutTimer.unref();
  }

  let idleTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = (): void => {
    if (!input.request.idleTimeoutMs || input.request.idleTimeoutMs <= 0) {
      return;
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      killChild("timeout");
    }, input.request.idleTimeoutMs);
    if (typeof idleTimer.unref === "function") {
      idleTimer.unref();
    }
  };
  resetIdleTimer();

  child.stdout.on("data", (chunk: Buffer) => {
    resetIdleTimer();
    stdout.ingest(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    resetIdleTimer();
    stderr.ingest(chunk);
  });

  try {
    const closed = await waitForChild(child);
    exitCode = closed.exitCode ?? undefined;
    processSignal = closed.signal ?? undefined;
  } catch (error) {
    stderr.ingest(Buffer.from(`Ling Stack unified exec process error: ${formatError(error)}\n`));
    exitCode = undefined;
  } finally {
    clearTimeout(timeoutTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    if (killTimer) {
      clearTimeout(killTimer);
    }
    input.signal?.removeEventListener("abort", abortListener);
    stdout.flush();
    stderr.flush();
  }

  const stdoutSnapshot = stdout.snapshot();
  const stderrSnapshot = stderr.snapshot();

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
      stdout: stdoutSnapshot,
      stderr: stderrSnapshot,
    });
    shellSnapshots.captureEnd(readUnifiedExecResult(handled));
    throw createAbortError();
  }

  const status: UnifiedExecStatus = timedOut
    ? "timed_out"
    : exitCode === 0
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
    stdout: stdoutSnapshot,
    stderr: stderrSnapshot,
  });
  shellSnapshots.captureEnd(readUnifiedExecResult(handled));
  return handled;
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
}): PiRunnerToolHandledResult {
  const secrets = input.extraSecrets ?? [];
  const startedAt = input.startedAt ?? new Date().toISOString();
  const startedMs = input.startedMs ?? Date.now();
  const stderr = createSyntheticStreamCapture(input.message, secrets);
  return writeUnifiedExecResult({
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
}

function writeUnifiedExecResult(input: {
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
      redacted: wasCommandRedacted(input.request.command, input.extraSecrets ?? []) || input.stdout.redacted || input.stderr.redacted,
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
    content: [{ type: "text", text: summarizeResult(result) }],
    details: { unifiedExec: result },
    isError: result.status !== "succeeded",
  };
}

function createStreamCapture(
  stream: "stdout" | "stderr",
  toolCallId: string,
  appendAndMaybeStream: RunEventEmitter,
  extraSecrets: readonly (string | undefined)[],
): {
  readonly ingest: (chunk: Buffer) => void;
  readonly flush: () => void;
  readonly snapshot: () => StreamCaptureSnapshot;
} {
  let rawByteCount = 0;
  let sequence = 0;
  let carry = "";
  const capture = createMutableStreamCapture();
  return {
    ingest(chunk) {
      rawByteCount += chunk.byteLength;
      const text = carry + chunk.toString("utf8");
      const emitLength = Math.max(0, text.length - REDACTION_CARRY_CHARS);
      carry = text.slice(emitLength);
      appendRedactedText(text.slice(0, emitLength));
    },
    flush() {
      appendRedactedText(carry);
      carry = "";
    },
    snapshot() {
      return {
        ...capture,
        byteCount: rawByteCount,
        lineCount: countLines(capture.artifactContent),
      };
    },
  };

  function appendRedactedText(text: string): void {
    if (!text) {
      return;
    }
    const redacted = redactTextWithSecrets(text, extraSecrets);
    const wasRedacted = redacted !== text;
    capture.redacted = capture.redacted || wasRedacted;
    appendBounded(capture, redacted);
    for (const chunkText of splitByBytes(redacted, OUTPUT_CHUNK_BYTES)) {
      sequence += 1;
      const chunk: UnifiedExecOutputChunk = {
        toolCallId,
        stream,
        sequence,
        text: chunkText,
        byteCount: Buffer.byteLength(chunkText, "utf8"),
        redacted: wasRedacted,
        truncated: false,
        ts: new Date().toISOString(),
      };
      appendAndMaybeStream("tool_update", {
        toolCallId,
        toolName: "bash",
        partialResult: chunk,
      });
    }
  }
}

function createSyntheticStreamCapture(text: string, extraSecrets: readonly (string | undefined)[]): StreamCaptureSnapshot {
  const redacted = redactTextWithSecrets(text, extraSecrets);
  const capture = createMutableStreamCapture();
  capture.redacted = redacted !== text;
  appendBounded(capture, redacted);
  return {
    ...capture,
    byteCount: Buffer.byteLength(text, "utf8"),
    lineCount: countLines(redacted),
  };
}

function createMutableStreamCapture(): MutableStreamCapture {
  return {
    byteCount: 0,
    lineCount: 0,
    preview: "",
    artifactContent: "",
    previewBytes: 0,
    artifactBytes: 0,
    previewTruncated: false,
    artifactTruncated: false,
    redacted: false,
  };
}

function appendBounded(capture: MutableStreamCapture, text: string): void {
  const previewRemaining = STREAM_PREVIEW_BYTES - capture.previewBytes;
  if (previewRemaining > 0) {
    const previewChunk = truncateToBytes(text, previewRemaining);
    capture.preview += previewChunk;
    capture.previewBytes += Buffer.byteLength(previewChunk, "utf8");
    if (previewChunk.length < text.length) {
      capture.previewTruncated = true;
    }
  } else if (text.length > 0) {
    capture.previewTruncated = true;
  }

  const artifactRemaining = ARTIFACT_BYTES - capture.artifactBytes;
  if (artifactRemaining <= 0) {
    capture.artifactTruncated = capture.artifactTruncated || text.length > 0;
    return;
  }
  const artifactChunk = truncateToBytes(text, artifactRemaining);
  capture.artifactContent += artifactChunk;
  capture.artifactBytes += Buffer.byteLength(artifactChunk, "utf8");
  if (artifactChunk.length < text.length) {
    capture.artifactTruncated = true;
  }
}

function toStreamSummary(capture: StreamCaptureSnapshot): UnifiedExecStreamSummary & { artifactId?: string } {
  return {
    byteCount: capture.byteCount,
    lineCount: capture.lineCount,
    preview: capture.preview,
    truncated: capture.previewTruncated || capture.artifactTruncated,
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

function spawnCommand(
  command: UnifiedExecCommand,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  if (command.kind === "argv") {
    const [file, ...args] = command.argv;
    if (!file) {
      throw new Error("argv command requires at least one argument.");
    }
    return spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
  }
  return spawn(command.shell ?? "bash", ["-lc", command.command], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
}

function waitForChild(child: ChildProcessWithoutNullStreams): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      if (!settled) {
        settled = true;
        resolve({ exitCode, signal });
      }
    });
  });
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to the child process if the process-group kill is unavailable.
  }
  try {
    child.kill(signal);
  } catch {
    // Termination is best-effort; the close event or run cancellation path owns final state.
  }
}

function summarizeResult(result: UnifiedExecResult): string {
  if (result.status === "timed_out") {
    return `Command timed out after ${result.durationMs}ms.`;
  }
  if (result.status === "cancelled") {
    return `Command cancelled after ${result.durationMs}ms.`;
  }
  if (result.exitCode !== undefined) {
    return `Command exited ${result.exitCode} in ${result.durationMs}ms.`;
  }
  return `Command ${result.status} in ${result.durationMs}ms.`;
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

function splitByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = truncateToBytes(remaining, maxBytes);
    if (!chunk) {
      break;
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  while (end < text.length && Buffer.byteLength(text.slice(0, end + 1), "utf8") <= maxBytes) {
    end += 1;
  }
  return text.slice(0, end);
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).length;
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputNumber(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readInputBoolean(input: unknown, key: string): boolean | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function readTimeoutMs(input: unknown): number | undefined {
  const timeoutMs = readInputNumber(input, "timeoutMs");
  if (timeoutMs !== undefined) {
    return timeoutMs;
  }
  const timeoutSeconds = readInputNumber(input, "timeout");
  return timeoutSeconds === undefined ? undefined : Math.max(1, Math.floor(timeoutSeconds * 1000));
}

function isPathInsideRoot(root: string, path: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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

interface MutableStreamCapture {
  byteCount: number;
  lineCount: number;
  preview: string;
  artifactContent: string;
  previewBytes: number;
  artifactBytes: number;
  previewTruncated: boolean;
  artifactTruncated: boolean;
  redacted: boolean;
}

interface StreamCaptureSnapshot {
  readonly byteCount: number;
  readonly lineCount: number;
  readonly preview: string;
  readonly artifactContent: string;
  readonly previewBytes: number;
  readonly artifactBytes: number;
  readonly previewTruncated: boolean;
  readonly artifactTruncated: boolean;
  readonly redacted: boolean;
}
