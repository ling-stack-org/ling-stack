import { parseCodeAssessmentInstructions } from "./code-assessment-comments.js";

/** A local Diff assessment never implies whole-repository or exploit validation. */
export type CodeAssessmentKind = "review" | "security";
export type CodeAssessmentTarget =
  | { readonly type: "working_tree" }
  | { readonly type: "branch"; readonly baseRef: string }
  | { readonly type: "commit"; readonly commitSha: string; readonly baseRef?: string };
export type CodeAssessmentStatus = "queued" | "analyzing" | "completed" | "partial" | "failed" | "cancelled" | "interrupted";
export type CodeAssessmentPhase = "preparing" | "collecting_diff" | "threat_model" | "reviewing_code" | "validating_output" | "validating_candidates" | "synthesizing_findings" | Exclude<CodeAssessmentStatus, "queued" | "analyzing">;
export interface CodeAssessmentPhaseEntry {
  readonly phase: CodeAssessmentPhase;
  readonly enteredAt: string;
  readonly status?: "skipped";
  readonly reason?: string;
}
export interface CodeAssessmentMetrics {
  readonly captureDurationMs?: number;
  readonly snapshotBytes?: number;
  readonly diffBytes?: number;
  readonly timeToSummaryMs?: number;
  readonly timeToFirstFindingMs?: number;
  readonly timeToFinalMs?: number;
  readonly cancelLatencyMs?: number;
  readonly reportBytes?: number;
}
export type CodeAssessmentRunPhase = "threat_model" | "reviewing_code";
export interface CodeAssessmentPhaseRun {
  readonly phase: CodeAssessmentRunPhase;
  readonly runId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly artifactId?: string;
}
export interface CodeAssessmentThreatModel {
  readonly snapshotDigest: string;
  readonly summary: string;
  readonly assets: readonly string[];
  readonly trustBoundaries: readonly string[];
  readonly attackerControls: readonly string[];
  readonly assumptions: readonly string[];
}
export type CodeFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type CodeFindingDisposition = "open" | "acknowledged" | "resolved" | "dismissed";
export type CodeFindingCloseReason = "false_positive" | "accepted_risk" | "not_reproducible" | "duplicate" | "out_of_scope";
export type CodeSnapshotExclusionReason = "sensitive" | "binary" | "truncated" | "budget" | "unsupported";

export interface CodeAssessmentSnapshotFile {
  readonly path: string;
  readonly originalPath?: string;
  readonly kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  readonly diff: string;
  readonly contentDigest: string;
  readonly redacted: boolean;
}

export interface CodeAssessmentSnapshot {
  readonly id: string;
  readonly digest: string;
  readonly capturedAt: string;
  readonly target: CodeAssessmentTarget;
  readonly branchName?: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly files: readonly CodeAssessmentSnapshotFile[];
  readonly totalFileCount: number;
  readonly coverage: "complete" | "partial";
  readonly exclusions: readonly { readonly path: string; readonly reason: CodeSnapshotExclusionReason }[];
}

export interface CodeAssessmentReviewRules {
  readonly baseSha: string;
  readonly sources: readonly {
    readonly path: string;
    readonly scope: string;
    readonly digest: string;
    readonly guidance: string;
  }[];
  readonly omitted: readonly string[];
}

export interface CodeAssessment {
  readonly id: string;
  readonly kind: CodeAssessmentKind;
  readonly status: CodeAssessmentStatus;
  readonly phase: CodeAssessmentPhase;
  readonly phaseHistory: readonly CodeAssessmentPhaseEntry[];
  readonly metrics: CodeAssessmentMetrics;
  readonly freshness?: CodeAssessmentFreshness;
  readonly validation: { readonly state: "not_run" | "inconclusive"; readonly reason: string };
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly target: CodeAssessmentTarget;
  readonly branchName?: string;
  readonly providerPresetId: string;
  readonly instructions?: string;
  readonly reviewRules?: CodeAssessmentReviewRules;
  readonly runId?: string;
  readonly phaseRuns?: readonly CodeAssessmentPhaseRun[];
  readonly threatModelArtifactId?: string;
  readonly reportArtifactId?: string;
  readonly diagnosticArtifactId?: string;
  readonly summary?: string;
  readonly errorMessage?: string;
  readonly findingCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CodeAssessmentFinding {
  readonly id: string;
  readonly assessmentId: string;
  readonly snapshotDigest: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly body: string;
  readonly severity: CodeFindingSeverity;
  readonly confidence: "high" | "medium" | "low";
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
  readonly evidence: string;
  readonly cwe?: string;
  readonly validation: "unverified";
  readonly disposition: CodeFindingDisposition;
  readonly dispositionReason?: string;
  readonly closeReason?: CodeFindingCloseReason;
  readonly freshnessState?: "current" | "stale";
}

export interface CodeAssessmentDetail {
  readonly assessment: CodeAssessment;
  readonly snapshot: CodeAssessmentSnapshot;
  readonly findings: readonly CodeAssessmentFinding[];
}

export interface CreateCodeAssessmentRequest {
  readonly kind: CodeAssessmentKind;
  readonly target: CodeAssessmentTarget;
  readonly providerPresetId: string;
  readonly instructions?: string;
}

export interface CodeAssessmentList {
  readonly assessments: readonly CodeAssessment[];
  readonly nextOffset?: number;
  readonly total?: number;
}

export interface CodeAssessmentListOptions {
  readonly kind?: CodeAssessmentKind;
  readonly targetType?: CodeAssessmentTarget["type"];
  readonly snapshotDigest?: string;
  readonly status?: CodeAssessmentStatus;
  readonly severity?: CodeFindingSeverity;
  readonly confidence?: CodeAssessmentFinding["confidence"];
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CodeAssessmentFreshness {
  readonly state: "current" | "stale" | "unknown";
  readonly checkedAt: string;
}

export function isActiveCodeAssessment(status: CodeAssessmentStatus): boolean {
  return status === "queued" || status === "analyzing";
}

export function isCodeAssessmentPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/^[A-Za-z]:|^[/\\]|[\u0000-\u001f\u007f]/u.test(path)
    && !path.includes("\\") && path.split("/").every(part => part !== ".." && part !== "." && part.length > 0);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be nonempty and at most ${max} characters.`);
  return value.trim();
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unexpected assessment field.");
}

export function parseCodeAssessmentTarget(value: unknown): CodeAssessmentTarget {
  const target = object(value);
  if (target.type === "working_tree") { keys(target, ["type"]); return { type: "working_tree" }; }
  if (target.type !== "branch" && target.type !== "commit") throw new Error("Choose working_tree, branch or commit.");
  keys(target, target.type === "commit" ? ["type", "commitSha", "baseRef"] : ["type", "baseRef"]);
  const baseRef = target.type === "commit" && target.baseRef === undefined ? undefined : text(target.baseRef, "baseRef", 200);
  if (baseRef && (baseRef.startsWith("-") || !/^[A-Za-z0-9_./@~^+-]+$/u.test(baseRef))) throw new Error("baseRef is not a supported Git revision.");
  if (target.type === "branch") return { type: "branch", baseRef: baseRef! };
  if (typeof target.commitSha !== "string" || !/^[a-fA-F0-9]{40}$/u.test(target.commitSha)) throw new Error("commitSha must be a full 40-character Git commit SHA.");
  return { type: "commit", commitSha: target.commitSha.toLowerCase(), ...(baseRef ? { baseRef } : {}) };
}

export function parseCreateCodeAssessment(value: unknown): CreateCodeAssessmentRequest {
  const input = object(value);
  keys(input, ["kind", "target", "providerPresetId", "instructions"]);
  if (input.kind !== "review" && input.kind !== "security") throw new Error("Choose review or security.");
  const instructions = parseCodeAssessmentInstructions(input.instructions);
  return { kind: input.kind, target: parseCodeAssessmentTarget(input.target), providerPresetId: text(input.providerPresetId, "providerPresetId", 200), ...(instructions ? { instructions } : {}) };
}

export interface CodeAssessmentModelFinding {
  readonly title: string;
  readonly body: string;
  readonly severity: CodeFindingSeverity;
  readonly confidence: "high" | "medium" | "low";
  readonly path: string;
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
  readonly evidence: string;
  readonly cwe?: string;
}

export function parseCodeAssessmentThreatModel(output: string, snapshot: CodeAssessmentSnapshot): CodeAssessmentThreatModel {
  if (output.length > 64 * 1024) throw new Error("Threat model exceeds its report budget.");
  const value = object(JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1")));
  keys(value, ["snapshotDigest", "summary", "assets", "trustBoundaries", "attackerControls", "assumptions"]);
  if (value.snapshotDigest !== snapshot.digest) throw new Error("Threat model does not match the captured snapshot.");
  const entries = (name: string): readonly string[] => {
    const items = value[name];
    if (!Array.isArray(items) || items.length > 12) throw new Error(`Threat model ${name} must contain at most 12 entries.`);
    return items.map(item => text(item, name, 1000));
  };
  return { snapshotDigest: snapshot.digest, summary: text(value.summary, "summary", 4000), assets: entries("assets"),
    trustBoundaries: entries("trustBoundaries"), attackerControls: entries("attackerControls"), assumptions: entries("assumptions") };
}

/** Only displayed hunk lines are valid evidence locations, including deleted lines. */
export function codeAssessmentHunkContent(diff: string, side: "old" | "new"): ReadonlyMap<number, string> {
  const lines = new Map<number, string>();
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
    } else if (oldRemaining > 0 || newRemaining > 0) {
      if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        lines.set(side === "old" ? oldLine : newLine, line.slice(1));
        oldRemaining--; newRemaining--; oldLine++; newLine++;
      } else if (line.startsWith("-") && oldRemaining > 0) {
        if (side === "old") lines.set(oldLine, line.slice(1));
        oldRemaining--; oldLine++;
      } else if (line.startsWith("+") && newRemaining > 0) {
        if (side === "new") lines.set(newLine, line.slice(1));
        newRemaining--; newLine++;
      }
    }
  }
  return lines;
}

export function codeAssessmentHunkLines(diff: string, side: "old" | "new"): ReadonlySet<number> {
  return new Set(codeAssessmentHunkContent(diff, side).keys());
}

export function parseCodeAssessmentModelOutput(output: string, snapshot: CodeAssessmentSnapshot): {
  readonly summary: string; readonly findings: readonly CodeAssessmentModelFinding[];
} {
  if (output.length > 256 * 1024) throw new Error("Assessment output exceeds the report budget.");
  const value = object(JSON.parse(output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1")));
  keys(value, ["summary", "findings", "snapshotDigest"]);
  if (value.snapshotDigest !== snapshot.digest) throw new Error("Assessment output does not match the captured snapshot.");
  if (!Array.isArray(value.findings) || value.findings.length > 50) throw new Error("Assessment findings must be an array of at most 50 items.");
  const findings = value.findings.map((raw): CodeAssessmentModelFinding => {
    const item = object(raw);
    keys(item, ["title", "body", "severity", "confidence", "path", "side", "startLine", "endLine", "evidence", "cwe"]);
    const path = text(item.path, "path", 1024);
    const file = snapshot.files.find(file => file.path === path);
    if (!file || !isCodeAssessmentPath(path)) throw new Error("Finding path is outside the captured Diff.");
    if (item.side !== "old" && item.side !== "new") throw new Error("Finding side must be old or new.");
    const { startLine, endLine } = item;
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || (startLine as number) < 1
      || (endLine as number) < (startLine as number) || (endLine as number) - (startLine as number) > 20) throw new Error("Finding line range is invalid.");
    const allowed = codeAssessmentHunkContent(file.diff, item.side);
    for (let line = startLine as number; line <= (endLine as number); line++) {
      if (!allowed.has(line)) throw new Error("Finding line is outside the captured hunk.");
    }
    if (!["critical", "high", "medium", "low", "info"].includes(String(item.severity))) throw new Error("Finding severity is invalid.");
    if (!["high", "medium", "low"].includes(String(item.confidence))) throw new Error("Finding confidence is invalid.");
    const cwe = item.cwe === undefined ? undefined : text(item.cwe, "cwe", 20);
    if (cwe && !/^CWE-\d+$/u.test(cwe)) throw new Error("Finding CWE is invalid.");
    const evidence = text(item.evidence, "evidence", 2000);
    const excerpt = Array.from({ length: (endLine as number) - (startLine as number) + 1 },
      (_, index) => allowed.get((startLine as number) + index)).join("\n");
    if (!excerpt.includes(evidence)) throw new Error("Finding evidence must quote its captured line range.");
    return { title: text(item.title, "title", 240), body: text(item.body, "body", 6000),
      severity: item.severity as CodeFindingSeverity, confidence: item.confidence as CodeAssessmentModelFinding["confidence"],
      path, side: item.side, startLine: startLine as number, endLine: endLine as number,
      evidence, ...(cwe ? { cwe } : {}) };
  });
  return { summary: text(value.summary, "summary", 8000), findings };
}
