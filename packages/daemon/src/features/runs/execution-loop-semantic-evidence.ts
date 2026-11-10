import { isCommandProcessObservation, isHostCommandSettledV1 } from "@ling-stack/contracts";
import type { UnifiedExecResult } from "@ling-stack/core";
import { renderUnifiedExecModelOutput } from "./unified-exec-model-output.js";

/** Comparison only, never a producer identity, authorization or persisted rewrite. */
export function semanticToolResult(toolName: string, toolCallId: string, value: unknown): unknown {
  if (toolName !== "bash" || !record(value) || !record(value.details)
    || !isUnifiedExecResult(value.details.unifiedExec, toolCallId)) return value;
  const result = value.details.unifiedExec;
  const content = Array.isArray(value.content) && value.content.length === 1
    && record(value.content[0]) && onlyKeys(value.content[0], ["type", "text"])
    && value.content[0].type === "text" && value.content[0].text === renderUnifiedExecModelOutput(result)
    ? [{ type: "text", text: renderUnifiedExecModelOutput({ ...result, durationMs: 0 }) }]
    : value.content;
  return { ...value, content, details: { ...value.details, unifiedExec: {
    ...without(result, ["toolCallId", "approvalId", "startedAt", "endedAt", "durationMs"]),
    stdout: without(result.stdout, ["artifactId"]),
    stderr: without(result.stderr, ["artifactId"]),
    artifacts: result.artifacts.map(artifact => without(artifact,
      artifact.role === "result" ? ["artifactId", "sizeBytes"] : ["artifactId"])),
  } } };
}

/** Host stream chunks carry observation coordinates, not cumulative progress. */
export function semanticToolUpdate(toolName: string, toolCallId: string, value: unknown): unknown {
  if (toolName !== "bash" || !record(value) || value.toolCallId !== toolCallId
    || !oneOf(value.stream, ["stdout", "stderr"]) || typeof value.text !== "string"
    || !nonNegativeInteger(value.byteCount) || !positiveInteger(value.sequence)
    || !timestamp(value.ts) || typeof value.redacted !== "boolean" || typeof value.truncated !== "boolean") return value;
  return without(value, ["toolCallId", "sequence", "ts"]);
}

/** Known Host bookkeeping must not mint progress solely through fresh IDs. */
export function semanticProgressEvent(type: string, data: unknown): unknown {
  if (type === "host_command_settled" && isHostCommandSettledV1(data)) return without(data, ["executionId"]);
  if (type !== "artifact_created" || !record(data) || data.toolName !== "bash"
    || !text(data.toolCallId) || !record(data.artifact)) return data;
  const artifact = data.artifact, role = data.role;
  if (!oneOf(role, ["result", "stdout", "stderr"]) || !text(artifact.runId)
    || !text(artifact.id) || artifact.id !== data.artifactId
    || (role === "result" && artifact.id !== artifactId(artifact.runId, data.toolCallId, role))
    || artifact.path !== `${artifact.runId}/unified-exec/${sanitizePath(data.toolCallId)}/${role === "result" ? "result.json" : `${role}.txt`}`
    || artifact.type !== (role === "result" ? "json" : "log")
    || artifact.title !== `Unified exec ${role}`
    || artifact.contentType !== (role === "result" ? "application/json" : "text/plain; charset=utf-8")
    || !nonNegativeInteger(artifact.sizeBytes) || !timestamp(artifact.createdAt)) return data;
  return { ...without(data, ["toolCallId", "artifactId"]), artifact: without(artifact,
    role === "result" ? ["id", "path", "createdAt", "sizeBytes"] : ["id", "path", "createdAt"]) };
}

/** Partial lookalikes fall back intact; no global key-name filtering is allowed. */
function isUnifiedExecResult(value: unknown, toolCallId: string): value is UnifiedExecResult {
  if (!record(value) || !oneOf(value.status, ["succeeded", "failed", "timed_out", "cancelled"])
    || !text(value.runId) || !text(value.taskId) || value.toolCallId !== toolCallId
    || (value.approvalId !== undefined && !text(value.approvalId)) || !text(value.cwd)
    || !command(value.command) || !environment(value.environmentSummary)
    || !timestamp(value.startedAt) || !timestamp(value.endedAt) || !nonNegativeInteger(value.durationMs)
    || (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode))
    || (value.signal !== undefined && !text(value.signal))
    || typeof value.timedOut !== "boolean" || typeof value.cancelled !== "boolean"
    || (value.processObservation !== undefined && !isCommandProcessObservation(value.processObservation))
    || !stream(value.stdout) || !stream(value.stderr) || !Array.isArray(value.artifacts)
    || !value.artifacts.every(artifactSummary)) return false;
  const expected = value.artifacts.filter(artifact => artifact.role === "result");
  if (expected.length !== 1 || expected[0].artifactId !== artifactId(value.runId, toolCallId, "result")) return false;
  let expectedArtifactCount = 1;
  for (const role of ["stdout", "stderr"] as const) {
    const output = value[role];
    if (!stream(output)) return false;
    // A legacy truncated preview cannot prove full-output equality.
    if (output.truncated && output.contentSha256 === undefined) return false;
    if (output.artifactId !== undefined) {
      expectedArtifactCount++;
      if (!value.artifacts.some(artifact => artifact.role === role && artifact.artifactId === output.artifactId)) return false;
    }
  }
  return value.artifacts.length === expectedArtifactCount && value.artifacts.every(artifact =>
    artifact.role === "result" || (artifact.role === "stdout" || artifact.role === "stderr")
      && artifact.artifactId === (value[artifact.role] as UnifiedExecResult["stdout"]).artifactId);
}

function command(value: unknown): boolean {
  return record(value) && (value.kind === "shell" && typeof value.command === "string"
    && (value.shell === undefined || text(value.shell))
    || value.kind === "argv" && strings(value.argv) && value.argv.length > 0);
}

function environment(value: unknown): boolean {
  return record(value) && oneOf(value.mode, ["inherit_minimal", "inherit_run", "explicit"])
    && text(value.cwd) && strings(value.keys) && strings(value.redactedKeys)
    && (value.pathEntryCount === undefined || nonNegativeInteger(value.pathEntryCount));
}

function stream(value: unknown): value is UnifiedExecResult["stdout"] {
  return record(value) && nonNegativeInteger(value.byteCount) && typeof value.preview === "string"
    && typeof value.truncated === "boolean" && (value.lineCount === undefined || nonNegativeInteger(value.lineCount))
    && (value.artifactId === undefined || text(value.artifactId))
    && (value.contentSha256 === undefined || typeof value.contentSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.contentSha256));
}

function artifactSummary(value: unknown): value is UnifiedExecResult["artifacts"][number] {
  return record(value) && text(value.artifactId) && oneOf(value.role, ["result", "stdout", "stderr", "combined"])
    && text(value.contentType) && nonNegativeInteger(value.sizeBytes)
    && typeof value.redacted === "boolean" && typeof value.truncated === "boolean";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function strings(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function oneOf(value: unknown, choices: readonly string[]): value is string { return typeof value === "string" && choices.includes(value); }
function timestamp(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positiveInteger(value: unknown): boolean { return nonNegativeInteger(value) && value > 0; }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }

function without(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function artifactId(runId: string, toolCallId: string, role: string): string {
  const sanitizeId = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_") || "id";
  return `artifact_${sanitizeId(runId)}_${sanitizeId(toolCallId)}_unified_exec_${role}`;
}

function sanitizePath(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "_") || "tool"; }
