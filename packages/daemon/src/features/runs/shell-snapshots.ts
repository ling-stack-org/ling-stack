import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ServerResponse } from "node:http";
import {
  type ArtifactType,
  type RunArtifact,
  type RunEventEnvelope,
  type RunSession,
  type RunStore,
  type ShellOutputSnapshot,
  type ShellSnapshot,
  type ShellSnapshotArtifactSummary,
  type ShellSnapshotListItem,
  type ShellSnapshotSource,
  type ShellSnapshotStatus,
  type UnifiedExecCommand,
  type UnifiedExecEnvironmentSummary,
  type UnifiedExecRequest,
  type UnifiedExecResult,
} from "@ling-stack/core";
import { normalizeArtifactPath } from "../../shared/path.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { resolveArtifactContentPath } from "./artifacts.js";

const COMMAND_PREVIEW_BYTES = 4 * 1024;
const STREAM_HEAD_BYTES = 8 * 1024;
const SNAPSHOT_TEXT_BYTES = 128 * 1024;

export interface ShellSnapshotWriter {
  captureStart(input: {
    readonly startedAt: string;
    readonly startedMs: number;
    readonly pid?: number;
  }): void;
  captureEnd(result: UnifiedExecResult): void;
}

export function createShellSnapshotWriter(input: {
  readonly enabled: boolean;
  readonly store: RunStore;
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
  readonly appendAndMaybeStream: (type: "artifact_created", data: unknown) => RunEventEnvelope | undefined;
  readonly extraSecrets?: readonly (string | undefined)[];
}): ShellSnapshotWriter {
  if (!input.enabled) {
    return {
      captureStart() {},
      captureEnd() {},
    };
  }
  let sequence = 0;
  const extraSecrets = input.extraSecrets ?? [];

  const capture = (source: ShellSnapshotSource, status: ShellSnapshotStatus, options: {
    readonly startedAt?: string;
    readonly startedMs?: number;
    readonly pid?: number;
    readonly result?: UnifiedExecResult;
  }): void => {
    try {
      sequence += 1;
      const snapshot = buildSnapshot({
        run: input.run,
        request: input.request,
        environmentSummary: input.environmentSummary,
        extraSecrets,
        sequence,
        source,
        status,
        ...options,
      });
      const json = `${JSON.stringify(snapshot, null, 2)}\n`;
      const text = renderSnapshotText(snapshot);
      const jsonArtifact = writeSnapshotArtifact({
        store: input.store,
        run: input.run,
        toolCallId: input.request.toolCallId,
        sequence,
        extension: "json",
        type: "json",
        title: `Shell snapshot ${sequence}: ${snapshot.status}`,
        contentType: "application/json",
        content: json,
        now: snapshot.createdAt,
      });
      const textArtifact = writeSnapshotArtifact({
        store: input.store,
        run: input.run,
        toolCallId: input.request.toolCallId,
        sequence,
        extension: "txt",
        type: "log",
        title: `Shell snapshot ${sequence}: ${snapshot.status} summary`,
        contentType: "text/plain; charset=utf-8",
        content: truncateToBytes(text, SNAPSHOT_TEXT_BYTES),
        now: snapshot.createdAt,
      });
      appendSnapshotArtifactEvents({
        artifacts: [
          { artifact: jsonArtifact, role: "shell_snapshot" },
          { artifact: textArtifact, role: "shell_snapshot_text" },
        ],
        snapshot,
        appendAndMaybeStream: input.appendAndMaybeStream,
      });
    } catch {
      // Snapshot artifacts are diagnostic evidence. A write/read failure must not make
      // an already-approved shell command fail.
    }
  };

  return {
    captureStart(start) {
      capture("exec_start", "starting", start);
    },
    captureEnd(result) {
      capture("exec_end", statusFromUnifiedExecResult(result), {
        startedAt: result.startedAt,
        startedMs: Date.now() - result.durationMs,
        result,
      });
    },
  };
}

export function handleListShellSnapshots(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry, runId: string): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }
  const toolCallId = url.searchParams.get("toolCallId") ?? undefined;
  const snapshots = listShellSnapshotArtifacts(store, runId, toolCallId)
    .map((artifact) => readSnapshotArtifact(store, artifact))
    .filter((entry): entry is { readonly artifact: RunArtifact; readonly snapshot: ShellSnapshot } => Boolean(entry))
    .map((entry) => toListItem(store, entry.artifact, entry.snapshot))
    .sort((left, right) => left.sequence - right.sequence);
  writeJson(response, 200, { runId, snapshots });
}

export function handleGetShellSnapshot(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry, runId: string, snapshotId: string): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }
  for (const artifact of listShellSnapshotArtifacts(store, runId)) {
    const entry = readSnapshotArtifact(store, artifact);
    if (entry?.snapshot.id === snapshotId) {
      const textArtifactId = findSnapshotTextArtifactId(store, artifact);
      writeJson(response, 200, {
        snapshot: entry.snapshot,
        artifactId: artifact.id,
        ...(textArtifactId ? { textArtifactId } : {}),
      });
      return;
    }
  }
  writeJson(response, 404, {
    error: "snapshot_not_found",
    message: `Shell snapshot was not found: ${snapshotId}`,
  });
}

function buildSnapshot(input: {
  readonly run: RunSession;
  readonly request: UnifiedExecRequest;
  readonly environmentSummary: UnifiedExecEnvironmentSummary;
  readonly extraSecrets: readonly (string | undefined)[];
  readonly sequence: number;
  readonly source: ShellSnapshotSource;
  readonly status: ShellSnapshotStatus;
  readonly startedAt?: string;
  readonly startedMs?: number;
  readonly pid?: number;
  readonly result?: UnifiedExecResult;
}): ShellSnapshot {
  const result = input.result;
  const createdAt = new Date().toISOString();
  const processStartedAt = result?.startedAt ?? input.startedAt;
  const processEndedAt = result?.endedAt;
  const stdout = result?.stdout;
  const stderr = result?.stderr;
  const stdoutArtifact = result?.artifacts.find((artifact) => artifact.role === "stdout");
  const stderrArtifact = result?.artifacts.find((artifact) => artifact.role === "stderr");
  const commandPreview = commandPreviewFor(input.request.command, input.extraSecrets);
  const commandRedacted = commandWasRedacted(input.request.command, input.extraSecrets);
  const stdoutRedacted = stdoutArtifact?.redacted ?? false;
  const stderrRedacted = stderrArtifact?.redacted ?? false;
  const artifacts = result
    ? result.artifacts.map((artifact): ShellSnapshotArtifactSummary => ({
        artifactId: artifact.artifactId,
        role: artifact.role === "result" ? "exec_result" : artifact.role,
        contentType: artifact.contentType,
        sizeBytes: artifact.sizeBytes,
      }))
    : [];

  return {
    id: snapshotIdFor(input.run.id, input.request.toolCallId, input.sequence),
    runId: input.run.id,
    taskId: input.run.taskId,
    toolCallId: input.request.toolCallId,
    approvalId: input.request.approvalId,
    sequence: input.sequence,
    createdAt,
    source: input.source,
    status: input.status,
    command: {
      cwd: input.request.cwd,
      commandKind: input.request.command.kind,
      commandPreview,
      ...(input.request.command.kind === "argv"
        ? { argvPreview: input.request.command.argv.slice(0, 64).map((item) => truncateToBytes(redactTextWithSecrets(item, input.extraSecrets), 1024)) }
        : {}),
      ...(input.request.command.kind === "shell" && input.request.command.shell ? { shell: input.request.command.shell } : {}),
      pty: input.request.pty === true,
      timeoutMs: input.request.timeoutMs,
      idleTimeoutMs: input.request.idleTimeoutMs,
      environmentSummary: input.environmentSummary,
    },
    process: {
      pid: input.pid,
      processGroupId: input.pid,
      startedAt: processStartedAt,
      endedAt: processEndedAt,
      durationMs: result?.durationMs ?? durationFrom(input.startedMs),
      exitCode: result?.exitCode,
      signal: result?.signal,
    },
    output: {
      stdoutHead: stdout?.preview ? truncateToBytes(stdout.preview, STREAM_HEAD_BYTES) : undefined,
      stderrHead: stderr?.preview ? truncateToBytes(stderr.preview, STREAM_HEAD_BYTES) : undefined,
      stdoutByteCount: stdout?.byteCount ?? 0,
      stderrByteCount: stderr?.byteCount ?? 0,
      stdoutLineCount: stdout?.lineCount,
      stderrLineCount: stderr?.lineCount,
      stdoutArtifactId: stdout?.artifactId,
      stderrArtifactId: stderr?.artifactId,
      truncated: stdout?.truncated === true || stderr?.truncated === true,
    },
    artifacts,
    redaction: {
      redacted: commandRedacted || stdoutRedacted || stderrRedacted,
      extraSecretCount: input.extraSecrets.filter((secret): secret is string => Boolean(secret)).length,
      commandRedacted,
      stdoutRedacted,
      stderrRedacted,
      environmentValuesStored: false,
    },
  };
}

function renderSnapshotText(snapshot: ShellSnapshot): string {
  return [
    `Shell Snapshot ${snapshot.id}`,
    `Status: ${snapshot.status}`,
    `Source: ${snapshot.source}`,
    `CWD: ${snapshot.command.cwd}`,
    `Command: ${snapshot.command.commandPreview}`,
    snapshot.process?.durationMs !== undefined ? `Duration: ${snapshot.process.durationMs}ms` : undefined,
    snapshot.process?.exitCode !== undefined ? `Exit code: ${snapshot.process.exitCode}` : undefined,
    snapshot.process?.signal ? `Signal: ${snapshot.process.signal}` : undefined,
    "",
    "stdout:",
    snapshot.output.stdoutHead ?? "",
    "",
    "stderr:",
    snapshot.output.stderrHead ?? "",
    "",
    `Artifacts: ${snapshot.artifacts.map((artifact) => `${artifact.role}:${artifact.artifactId}`).join(", ") || "none"}`,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function writeSnapshotArtifact(input: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly toolCallId: string;
  readonly sequence: number;
  readonly extension: "json" | "txt";
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType: string;
  readonly content: string;
  readonly now: string;
}): RunArtifact {
  const safeToolCallId = sanitizePathSegment(input.toolCallId);
  const sequence = String(input.sequence).padStart(6, "0");
  const relativePath = normalizeArtifactPath(`${input.run.id}/shell-snapshots/${safeToolCallId}/${sequence}.${input.extension}`);
  const absolutePath = resolvePath(input.store.paths.artifactsDir, relativePath);
  const relativeToRoot = relative(input.store.paths.artifactsDir, absolutePath);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    throw new Error(`Shell snapshot artifact path escaped artifact root: ${relativePath}`);
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.content, "utf8");
  const stats = statSync(absolutePath);
  return input.store.createArtifact({
    runId: input.run.id,
    type: input.type,
    path: relativePath,
    title: input.title,
    contentType: input.contentType,
    sizeBytes: Number(stats.size),
    createdAt: input.now,
  });
}

function appendSnapshotArtifactEvents(input: {
  readonly artifacts: readonly { readonly artifact: RunArtifact; readonly role: "shell_snapshot" | "shell_snapshot_text" }[];
  readonly snapshot: ShellSnapshot;
  readonly appendAndMaybeStream: (type: "artifact_created", data: unknown) => RunEventEnvelope | undefined;
}): void {
  for (const item of input.artifacts) {
    input.appendAndMaybeStream("artifact_created", {
      artifact: item.artifact,
      artifactId: item.artifact.id,
      toolCallId: input.snapshot.toolCallId,
      toolName: "bash",
      role: item.role,
      snapshotId: input.snapshot.id,
      snapshotSource: input.snapshot.source,
      snapshotStatus: input.snapshot.status,
    });
  }
}

function listShellSnapshotArtifacts(store: RunStore, runId: string, toolCallId?: string): RunArtifact[] {
  return store
    .listArtifacts(runId)
    .filter((artifact) => isShellSnapshotJsonPath(artifact.path))
    .filter((artifact) => toolCallId === undefined || artifact.path.includes(`/shell-snapshots/${sanitizePathSegment(toolCallId)}/`));
}

function readSnapshotArtifact(store: RunStore, artifact: RunArtifact): { readonly artifact: RunArtifact; readonly snapshot: ShellSnapshot } | undefined {
  try {
    const content = readFileSync(resolveArtifactContentPath(store, artifact), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!isShellSnapshot(parsed)) {
      return undefined;
    }
    return { artifact, snapshot: parsed };
  } catch {
    return undefined;
  }
}

function toListItem(store: RunStore, artifact: RunArtifact, snapshot: ShellSnapshot): ShellSnapshotListItem {
  const textArtifactId = findSnapshotTextArtifactId(store, artifact);
  return {
    id: snapshot.id,
    runId: snapshot.runId,
    toolCallId: snapshot.toolCallId,
    sequence: snapshot.sequence,
    createdAt: snapshot.createdAt,
    source: snapshot.source,
    status: snapshot.status,
    commandPreview: snapshot.command.commandPreview,
    durationMs: snapshot.process?.durationMs,
    exitCode: snapshot.process?.exitCode,
    artifactId: artifact.id,
    ...(textArtifactId ? { textArtifactId } : {}),
  };
}

function findSnapshotTextArtifactId(store: RunStore, jsonArtifact: RunArtifact): string | undefined {
  const textPath = jsonArtifact.path.replace(/\.json$/, ".txt");
  return store.listArtifacts(jsonArtifact.runId ?? "").find((artifact) => artifact.path === textPath)?.id;
}

function isShellSnapshotJsonPath(path: string): boolean {
  return path.includes("/shell-snapshots/") && path.endsWith(".json");
}

function isShellSnapshot(value: unknown): value is ShellSnapshot {
  return isRecord(value) && typeof value.id === "string" && typeof value.runId === "string" && typeof value.toolCallId === "string";
}

function snapshotIdFor(runId: string, toolCallId: string, sequence: number): string {
  return `shell_snapshot:${runId}:${toolCallId}:${String(sequence).padStart(6, "0")}`;
}

function statusFromUnifiedExecResult(result: UnifiedExecResult): ShellSnapshotStatus {
  if (result.status === "cancelled") {
    return "cancelled";
  }
  if (result.status === "timed_out") {
    return "timed_out";
  }
  if (result.status === "failed") {
    return "failed";
  }
  return "exited";
}

function commandPreviewFor(command: UnifiedExecCommand, extraSecrets: readonly (string | undefined)[]): string {
  if (command.kind === "argv") {
    return command.argv.map((item) => truncateToBytes(redactTextWithSecrets(item, extraSecrets), 1024)).join(" ");
  }
  return truncateToBytes(redactTextWithSecrets(command.command, extraSecrets), COMMAND_PREVIEW_BYTES);
}

function commandWasRedacted(command: UnifiedExecCommand, extraSecrets: readonly (string | undefined)[]): boolean {
  return commandPreviewFor(command, extraSecrets) !== commandPreviewFor(command, []);
}

function durationFrom(startedMs: number | undefined): number | undefined {
  return startedMs === undefined ? undefined : Math.max(0, Date.now() - startedMs);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_");
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
