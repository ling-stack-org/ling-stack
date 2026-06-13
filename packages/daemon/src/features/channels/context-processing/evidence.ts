import { redactSecrets, type ChannelWorkflowStep, type RunArtifact } from "@ling-stack/core";
import type { ChannelContextSensitivity, ChannelContextSourceKind } from "./types.js";

const EVIDENCE_SECRET_TOKEN_PATTERN = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|ghp_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|xox[abp]-[A-Za-z0-9-]{8,})\b/g;

export type WorkflowEvidencePacketKind = "context" | "output";

export interface CommandEvidenceArtifactRef {
  readonly id: string;
  readonly label?: string;
}

export interface CommandEvidenceSummaryInput {
  readonly command?: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly changedPaths?: readonly string[];
  readonly artifactRefs?: readonly CommandEvidenceArtifactRef[];
  readonly extraSecrets?: readonly string[];
  readonly maxTailChars?: number;
}

export function workflowPacketKindForArtifact(
  step: ChannelWorkflowStep | undefined,
  artifact: RunArtifact,
): WorkflowEvidencePacketKind | undefined {
  if (step?.metadata?.contextArtifactId === artifact.id) {
    return "context";
  }
  if (step?.metadata?.outputArtifactId === artifact.id || step?.metadata?.outputArtifactIds?.includes(artifact.id)) {
    return "output";
  }
  return undefined;
}

export function evidenceKindForArtifact(packetKind: WorkflowEvidencePacketKind | undefined): Extract<ChannelContextSourceKind, "artifact" | "workflow_packet"> {
  return packetKind ? "workflow_packet" : "artifact";
}

export function artifactEvidenceSensitivity(artifact: RunArtifact): ChannelContextSensitivity {
  return artifact.type === "log" ? "secret_adjacent" : "normal";
}

export function summarizeArtifactEvidence(input: {
  readonly artifact: RunArtifact;
  readonly packetKind?: WorkflowEvidencePacketKind;
}): string {
  const artifact = input.artifact;
  return [
    input.packetKind ? `Workflow ${input.packetKind} packet artifact.` : "Artifact evidence.",
    `type=${artifact.type}`,
    `path=${redactEvidenceText(artifact.path)}`,
    artifact.contentType ? `contentType=${artifact.contentType}` : undefined,
    artifact.sizeBytes !== undefined ? `sizeBytes=${artifact.sizeBytes}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function summarizeCommandEvidence(input: CommandEvidenceSummaryInput): string {
  const exitCode = input.exitCode ?? 0;
  const artifactRefs = input.artifactRefs ?? [];
  const changedPaths = input.changedPaths ?? [];
  const includeStderrTail = exitCode !== 0 && Boolean(input.stderr?.trim());
  const stdoutLength = input.stdout?.length ?? 0;
  const stderrLength = input.stderr?.length ?? 0;
  const extraSecrets = input.extraSecrets ?? [];
  return [
    "Command evidence:",
    input.command ? `command=${redactEvidenceText(input.command, extraSecrets)}` : undefined,
    `exitCode=${exitCode}`,
    changedPaths.length > 0 ? `changedPaths=${changedPaths.map((path) => redactEvidenceText(path, extraSecrets)).join(", ")}` : undefined,
    artifactRefs.length > 0 ? `artifactRefs=${artifactRefs.map((ref) => ref.label ? `${ref.id}:${redactEvidenceText(ref.label, extraSecrets)}` : ref.id).join(", ")}` : undefined,
    stdoutLength > 0 ? `stdout=omitted (${stdoutLength} chars; see artifact refs or inspect view)` : undefined,
    stderrLength > 0 && !includeStderrTail ? `stderr=omitted (${stderrLength} chars; see artifact refs or inspect view)` : undefined,
    includeStderrTail ? `stderrTail:\n${boundedRedactedTail(input.stderr ?? "", input.maxTailChars ?? 600, extraSecrets)}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function redactEvidenceText(value: string, extraSecrets: readonly (string | undefined)[] = []): string {
  return String(redactSecrets(value, extraSecrets)).replace(EVIDENCE_SECRET_TOKEN_PATTERN, "[REDACTED]");
}

function boundedRedactedTail(value: string, maxChars: number, extraSecrets: readonly (string | undefined)[]): string {
  const redacted = redactEvidenceText(value, extraSecrets).trim();
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `[truncated stderr tail]\n${redacted.slice(Math.max(0, redacted.length - maxChars))}`;
}
