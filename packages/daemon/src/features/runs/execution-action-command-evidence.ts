import {
  type ExecutionActionCommandEvidence,
  type ExecutionActionCommandOutputChunk,
  type RunEventEnvelope,
} from "@ling-stack/core";
import { isRecord } from "../../shared/validation.js";

const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_OUTPUT_LINES = 40;
const MAX_OUTPUT_CHUNKS = 64;

interface UnifiedExecResultLike {
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly cwd: string;
  readonly command: unknown;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: UnifiedExecStreamSummaryLike;
  readonly stderr: UnifiedExecStreamSummaryLike;
  readonly artifacts: readonly UnifiedExecArtifactLike[];
}

interface UnifiedExecStreamSummaryLike {
  readonly byteCount: number;
  readonly lineCount?: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly artifactId?: string;
}

interface UnifiedExecArtifactLike {
  readonly artifactId: string;
  readonly role: "result" | "stdout" | "stderr" | "combined";
}

export function deriveExecutionActionCommandEvidence(input: {
  readonly events: readonly RunEventEnvelope[];
  readonly toolCallId: string;
  readonly start?: RunEventEnvelope;
  readonly end?: RunEventEnvelope;
}): ExecutionActionCommandEvidence | undefined {
  const result = readUnifiedExecResult(input.end);
  const command = readCommand(result?.command) ?? readCommand(readToolArgs(input.start));
  if (!command) {
    return undefined;
  }

  const updateEvents = input.events.filter((event) =>
    event.type === "tool_update" && readToolCallId(event) === input.toolCallId,
  );
  const streamedChunks = updateEvents
    .map(readOutputChunk)
    .filter((chunk): chunk is ExecutionActionCommandOutputChunk => Boolean(chunk));
  const chunks = addFinalPreviewFallbacks(streamedChunks, result, input.end);
  const bounded = boundOutputChunks(chunks);
  const latestEventSeq = Math.max(
    input.start?.seq ?? 0,
    input.end?.seq ?? 0,
    ...updateEvents.map((event) => event.seq),
  );
  const artifactIds = result ? artifactIdsByRole(result.artifacts) : {};
  const outputByteCount = result
    ? result.stdout.byteCount + result.stderr.byteCount
    : chunks.reduce((sum, chunk) => sum + chunk.byteCount, 0);
  const outputLineCount = result
    ? sumDefined(result.stdout.lineCount, result.stderr.lineCount)
    : countChunkLines(chunks);

  return {
    command,
    cwd: result?.cwd ?? readString(readToolArgs(input.start), "cwd"),
    startedAt: result?.startedAt ?? input.start?.ts,
    completedAt: result?.endedAt ?? input.end?.ts,
    durationMs: result?.durationMs ?? durationBetween(input.start?.ts, input.end?.ts),
    exitCode: result?.exitCode,
    signal: result?.signal,
    timedOut: result?.timedOut,
    cancelled: result?.cancelled,
    latestEventSeq,
    outputTail: bounded.chunks,
    outputByteCount,
    outputLineCount,
    outputTruncated: bounded.truncated || Boolean(result?.stdout.truncated || result?.stderr.truncated),
    stdoutArtifactId: result?.stdout.artifactId ?? artifactIds.stdout,
    stderrArtifactId: result?.stderr.artifactId ?? artifactIds.stderr,
    resultArtifactId: artifactIds.result,
  };
}

export function executionActionStatusFromCommandEvidence(
  evidence: ExecutionActionCommandEvidence | undefined,
): "succeeded" | "failed" | "cancelled" | undefined {
  if (!evidence?.completedAt) {
    return undefined;
  }
  if (evidence.cancelled) {
    return "cancelled";
  }
  if (evidence.timedOut || (evidence.exitCode !== undefined && evidence.exitCode !== 0)) {
    return "failed";
  }
  return evidence.exitCode === 0 ? "succeeded" : undefined;
}

function readOutputChunk(event: RunEventEnvelope): ExecutionActionCommandOutputChunk | undefined {
  if (!isRecord(event.data) || !isRecord(event.data.partialResult)) {
    return undefined;
  }
  const chunk = event.data.partialResult;
  if (
    (chunk.stream !== "stdout" && chunk.stream !== "stderr") ||
    typeof chunk.text !== "string"
  ) {
    return undefined;
  }
  const text = stripAnsi(chunk.text);
  if (!text) {
    return undefined;
  }
  return {
    eventSeq: event.seq,
    stream: chunk.stream,
    text,
    byteCount: Buffer.byteLength(text, "utf8"),
    redacted: chunk.redacted === true,
    ts: typeof chunk.ts === "string" ? chunk.ts : event.ts,
  };
}

function addFinalPreviewFallbacks(
  chunks: readonly ExecutionActionCommandOutputChunk[],
  result: UnifiedExecResultLike | undefined,
  end: RunEventEnvelope | undefined,
): ExecutionActionCommandOutputChunk[] {
  const output = [...chunks];
  if (!result || !end) {
    return output;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const summary = result[stream];
    if (!summary.preview || output.some((chunk) => chunk.stream === stream)) {
      continue;
    }
    const text = stripAnsi(summary.preview);
    if (!text) {
      continue;
    }
    output.push({
      eventSeq: end.seq,
      stream,
      text,
      byteCount: Buffer.byteLength(text, "utf8"),
      redacted: false,
      ts: end.ts,
    });
  }
  return output.sort((left, right) => left.eventSeq - right.eventSeq || left.stream.localeCompare(right.stream));
}

function boundOutputChunks(chunks: readonly ExecutionActionCommandOutputChunk[]): {
  readonly chunks: readonly ExecutionActionCommandOutputChunk[];
  readonly truncated: boolean;
} {
  let bounded = chunks.slice(-MAX_OUTPUT_CHUNKS).map((chunk) => ({ ...chunk }));
  let truncated = chunks.length > MAX_OUTPUT_CHUNKS;

  while (countChunkLines(bounded) > MAX_OUTPUT_LINES && bounded.length > 0) {
    const [first, ...rest] = bounded;
    const remainingLines = countChunkLines(rest);
    const allowedLines = MAX_OUTPUT_LINES - remainingLines;
    if (allowedLines <= 0) {
      bounded = rest;
      truncated = true;
      continue;
    }
    const text = takeLastLines(first.text, allowedLines);
    bounded = [{ ...first, text, byteCount: Buffer.byteLength(text, "utf8") }, ...rest];
    truncated = true;
    break;
  }

  while (countChunkBytes(bounded) > MAX_OUTPUT_BYTES && bounded.length > 0) {
    const [first, ...rest] = bounded;
    const remainingBytes = countChunkBytes(rest);
    const allowedBytes = MAX_OUTPUT_BYTES - remainingBytes;
    if (allowedBytes <= 0) {
      bounded = rest;
      truncated = true;
      continue;
    }
    const text = takeLastUtf8Bytes(first.text, allowedBytes);
    bounded = [{ ...first, text, byteCount: Buffer.byteLength(text, "utf8") }, ...rest];
    truncated = true;
    break;
  }

  return {
    chunks: bounded.filter((chunk) => chunk.text.length > 0),
    truncated,
  };
}

function readUnifiedExecResult(event: RunEventEnvelope | undefined): UnifiedExecResultLike | undefined {
  if (!event || !isRecord(event.data)) {
    return undefined;
  }
  const eventResult = event.data.result;
  const candidate = isRecord(eventResult) && isRecord(eventResult.details)
    ? eventResult.details.unifiedExec
    : isRecord(eventResult) && "unifiedExec" in eventResult
      ? eventResult.unifiedExec
      : eventResult;
  if (!isRecord(candidate) || !isUnifiedExecStatus(candidate.status)) {
    return undefined;
  }
  if (
    typeof candidate.cwd !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.endedAt !== "string" ||
    typeof candidate.durationMs !== "number" ||
    typeof candidate.timedOut !== "boolean" ||
    typeof candidate.cancelled !== "boolean" ||
    !isUnifiedExecStreamSummary(candidate.stdout) ||
    !isUnifiedExecStreamSummary(candidate.stderr) ||
    !Array.isArray(candidate.artifacts)
  ) {
    return undefined;
  }
  return {
    status: candidate.status,
    cwd: candidate.cwd,
    command: candidate.command,
    startedAt: candidate.startedAt,
    endedAt: candidate.endedAt,
    durationMs: candidate.durationMs,
    exitCode: typeof candidate.exitCode === "number" ? candidate.exitCode : undefined,
    signal: typeof candidate.signal === "string" ? candidate.signal : undefined,
    timedOut: candidate.timedOut,
    cancelled: candidate.cancelled,
    stdout: candidate.stdout,
    stderr: candidate.stderr,
    artifacts: candidate.artifacts.filter(isUnifiedExecArtifact),
  };
}

function isUnifiedExecStatus(value: unknown): value is UnifiedExecResultLike["status"] {
  return value === "succeeded" || value === "failed" || value === "timed_out" || value === "cancelled";
}

function isUnifiedExecStreamSummary(value: unknown): value is UnifiedExecStreamSummaryLike {
  return isRecord(value) &&
    typeof value.byteCount === "number" &&
    typeof value.preview === "string" &&
    typeof value.truncated === "boolean";
}

function isUnifiedExecArtifact(value: unknown): value is UnifiedExecArtifactLike {
  return isRecord(value) &&
    typeof value.artifactId === "string" &&
    (value.role === "result" || value.role === "stdout" || value.role === "stderr" || value.role === "combined");
}

function artifactIdsByRole(artifacts: readonly UnifiedExecArtifactLike[]): Partial<Record<UnifiedExecArtifactLike["role"], string>> {
  const result: Partial<Record<UnifiedExecArtifactLike["role"], string>> = {};
  for (const artifact of artifacts) {
    result[artifact.role] ??= artifact.artifactId;
  }
  return result;
}

function readToolCallId(event: RunEventEnvelope): string | undefined {
  return isRecord(event.data) && typeof event.data.toolCallId === "string" ? event.data.toolCallId : undefined;
}

function readToolArgs(event: RunEventEnvelope | undefined): unknown {
  return event && isRecord(event.data) ? event.data.args : undefined;
}

function readCommand(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.command === "string") {
    return value.command.trim() || undefined;
  }
  if (Array.isArray(value.argv) && value.argv.every((entry) => typeof entry === "string")) {
    return value.argv.join(" ").trim() || undefined;
  }
  return undefined;
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function countChunkBytes(chunks: readonly ExecutionActionCommandOutputChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
}

function countChunkLines(chunks: readonly ExecutionActionCommandOutputChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + countLines(chunk.text), 0);
}

function countLines(value: string): number {
  return value ? value.split(/\r?\n/u).length : 0;
}

function takeLastLines(value: string, limit: number): string {
  return value.split(/\r?\n/u).slice(-limit).join("\n");
}

function takeLastUtf8Bytes(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) {
    return value;
  }
  const characters = Array.from(value);
  let start = characters.length;
  let bytes = 0;
  while (start > 0) {
    const character = characters[start - 1] ?? "";
    const sliceBytes = Buffer.byteLength(character, "utf8");
    if (bytes + sliceBytes > limit) {
      break;
    }
    bytes += sliceBytes;
    start -= 1;
  }
  return characters.slice(start).join("");
}

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu, "");
}
