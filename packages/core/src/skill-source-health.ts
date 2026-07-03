import { GSTACK_DEFAULT_SKILL_PACK_ID } from "./builtin-skill-packs.js";
import type {
  SkillRegistryEntry,
  SkillSourceContextFindingEvidence,
  SkillSourceContextHealthFinding,
  SkillSourceContextHealthFindingKind,
  SkillSourceFileRef,
  SkillSourceSnapshot,
  SkillSourceWarning,
} from "./skill-types.js";

export type SkillSourceHealthFindingKind =
  | "missing_source_snapshot"
  | "source_warning"
  | "orphaned_source_snapshot"
  | SkillSourceContextHealthFindingKind;

export type SkillSourceHealthSeverity = "info" | "warning" | "critical";

export interface SkillSourceHealthFinding {
  readonly kind: SkillSourceHealthFindingKind;
  readonly severity: SkillSourceHealthSeverity;
  readonly skillId?: string;
  readonly snapshotId?: string;
  readonly title: string;
  readonly message: string;
  readonly evidence?: readonly SkillSourceContextHealthFinding["evidence"][number][];
  readonly tokenEstimate?: number;
  readonly recommendation?: string;
}

export interface SkillSourceHealthSummary {
  readonly totalSkills: number;
  readonly sourceBackedSkills: number;
  readonly missingSourceSnapshots: number;
  readonly warningSnapshots: number;
  readonly orphanedSnapshots: number;
}

export interface SkillSourceHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: SkillSourceHealthSummary;
  readonly findings: readonly SkillSourceHealthFinding[];
}

export interface BuildSkillSourceHealthReportInput {
  readonly workspaceId: string;
  readonly skills: readonly SkillRegistryEntry[];
  readonly snapshots: readonly SkillSourceSnapshot[];
  readonly generatedAt: string;
  readonly limit?: number;
}

export function buildSkillSourceHealthReport(input: BuildSkillSourceHealthReportInput): SkillSourceHealthReport {
  const skillsById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const publishedSnapshots = input.snapshots.filter((snapshot) => snapshot.reviewStatus === "published");
  const snapshotsBySkillId = new Map(publishedSnapshots.map((snapshot) => [snapshot.skillId, snapshot]));
  const sourceExpectedSkills = input.skills.filter((skill) => isSourceExpectedSkill(skill));
  const findings: SkillSourceHealthFinding[] = [];

  for (const skill of sourceExpectedSkills) {
    if (!snapshotsBySkillId.has(skill.id)) {
      findings.push({
        kind: "missing_source_snapshot",
        severity: "info",
        skillId: skill.id,
        title: "Skill source snapshot missing",
        message: `${skill.id} has registry metadata but no published source snapshot.`,
        recommendation: "Publish a reviewed source snapshot before relying on source-backed runtime context.",
      });
    }
  }

  for (const snapshot of publishedSnapshots) {
    if (!skillsById.has(snapshot.skillId)) {
      findings.push({
        kind: "orphaned_source_snapshot",
        severity: "warning",
        skillId: snapshot.skillId,
        snapshotId: snapshot.id,
        title: "Orphaned skill source snapshot",
        message: `${snapshot.id} points at missing or archived skill ${snapshot.skillId}.`,
      });
    }
    if (snapshot.warnings.length > 0) {
      findings.push({
        kind: "source_warning",
        severity: sourceWarningSeverity(snapshot),
        skillId: snapshot.skillId,
        snapshotId: snapshot.id,
        title: "Skill source warning",
        message: `${snapshot.id} has ${snapshot.warnings.length} source warning(s).`,
      });
    }
    findings.push(...buildSkillSourceContextFindings({
      skillId: snapshot.skillId,
      snapshotId: snapshot.id,
      markdown: snapshot.rawSkillMarkdown,
      referencedFiles: snapshot.referencedFiles,
      warnings: snapshot.warnings,
      routingDescription: findRoutingDescription(snapshot),
    }));
  }

  const limitedFindings = input.limit ? findings.slice(0, input.limit) : findings;
  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    summary: {
      totalSkills: input.skills.length,
      sourceBackedSkills: snapshotsBySkillId.size,
      missingSourceSnapshots: sourceExpectedSkills.filter((skill) => !snapshotsBySkillId.has(skill.id)).length,
      warningSnapshots: publishedSnapshots.filter((snapshot) => snapshot.warnings.length > 0).length,
      orphanedSnapshots: publishedSnapshots.filter((snapshot) => !skillsById.has(snapshot.skillId)).length,
    },
    findings: limitedFindings,
  };
}

function isSourceExpectedSkill(skill: SkillRegistryEntry): boolean {
  return skill.packId === GSTACK_DEFAULT_SKILL_PACK_ID || skill.source === "gstack" || skill.source === "skill-directory";
}

function sourceWarningSeverity(snapshot: SkillSourceSnapshot): SkillSourceHealthSeverity {
  if (snapshot.warnings.some((warning) => warning.severity === "error")) {
    return "critical";
  }
  if (snapshot.warnings.some((warning) => warning.severity === "warning")) {
    return "warning";
  }
  return "info";
}

export interface BuildSkillSourceContextFindingsInput {
  readonly skillId: string;
  readonly snapshotId?: string;
  readonly markdown: string;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings?: readonly SkillSourceWarning[];
  readonly routingDescription?: string;
}

const TOKEN_BLOAT_SOURCE_WARNING_TOKENS = 8_000;
const TOKEN_BLOAT_SOURCE_CRITICAL_TOKENS = 20_000;
const TOKEN_BLOAT_REFERENCE_WARNING_BYTES = 32_000;
const WEAK_DESCRIPTION_MIN_WORDS = 5;
const WEAK_DESCRIPTION_MIN_CHARS = 30;

export function buildSkillSourceContextFindings(input: BuildSkillSourceContextFindingsInput): SkillSourceContextHealthFinding[] {
  const findings: SkillSourceContextHealthFinding[] = [];
  const sourceTokenEstimate = estimateTokens(input.markdown);
  if (sourceTokenEstimate >= TOKEN_BLOAT_SOURCE_WARNING_TOKENS) {
    findings.push({
      kind: "token_bloat",
      severity: sourceTokenEstimate >= TOKEN_BLOAT_SOURCE_CRITICAL_TOKENS ? "critical" : "warning",
      skillId: input.skillId,
      snapshotId: input.snapshotId,
      title: "Skill source token bloat",
      message: `${input.skillId} source is estimated at ${sourceTokenEstimate} tokens before referenced files.`,
      tokenEstimate: sourceTokenEstimate,
      evidence: [{
        sourceRef: "SKILL.md",
        tokenEstimate: sourceTokenEstimate,
        message: "Large source bodies dilute runtime context and should be split into core rules plus lazy references.",
      }],
      recommendation: "Keep actionable core rules in the default runtime context and move background, examples, and templates behind lazy references.",
    });
  }

  for (const file of input.referencedFiles) {
    if ((file.sizeBytes ?? 0) >= TOKEN_BLOAT_REFERENCE_WARNING_BYTES) {
      findings.push({
        kind: "token_bloat",
        severity: "warning",
        skillId: input.skillId,
        snapshotId: input.snapshotId,
        title: "Large skill reference",
        message: `${file.path} is ${file.sizeBytes} bytes and should not be injected by default.`,
        tokenEstimate: estimateTokensFromBytes(file.sizeBytes ?? 0),
        evidence: [{
          sourceRef: file.path,
          tokenEstimate: estimateTokensFromBytes(file.sizeBytes ?? 0),
          message: "Large referenced files should stay lazy until the task needs them.",
        }],
        recommendation: "Expose this file through a lazy reference index instead of default prompt injection.",
      });
    }
  }

  const descriptionFinding = weakDescriptionFinding(input);
  if (descriptionFinding) {
    findings.push(descriptionFinding);
  }

  const duplicateReferenceFindings = referenceDuplicationFindings(input);
  findings.push(...duplicateReferenceFindings);

  const bodyTaxonomyFinding = mixedBodyTaxonomyFinding(input);
  if (bodyTaxonomyFinding) {
    findings.push(bodyTaxonomyFinding);
  }

  const unsafeFinding = optimizationUnsafeFinding(input);
  if (unsafeFinding) {
    findings.push(unsafeFinding);
  }

  return findings;
}

function weakDescriptionFinding(input: BuildSkillSourceContextFindingsInput): SkillSourceContextHealthFinding | undefined {
  const description = normalizeWhitespace(input.routingDescription ?? parseFrontMatterDescription(input.markdown) ?? "");
  const words = description.split(/\s+/u).filter(Boolean);
  if (description.length >= WEAK_DESCRIPTION_MIN_CHARS && words.length >= WEAK_DESCRIPTION_MIN_WORDS && !isGenericDescription(description)) {
    return undefined;
  }
  return {
    kind: "missing_or_weak_routing_description",
    severity: "warning",
    skillId: input.skillId,
    snapshotId: input.snapshotId,
    title: "Missing or weak routing description",
    message: description
      ? `${input.skillId} has a weak routing description: "${truncate(description, 80)}".`
      : `${input.skillId} has no usable routing description.`,
    evidence: [{
      sourceRef: "SKILL.md",
      message: "Routing descriptions should identify when the skill should be selected, not just restate a generic task.",
    }],
    recommendation: "Add a concise trigger-oriented description before relying on automatic routing.",
  };
}

function referenceDuplicationFindings(input: BuildSkillSourceContextFindingsInput): SkillSourceContextHealthFinding[] {
  const byChecksum = new Map<string, SkillSourceFileRef[]>();
  for (const file of input.referencedFiles) {
    if (!file.checksum) {
      continue;
    }
    byChecksum.set(file.checksum, [...(byChecksum.get(file.checksum) ?? []), file]);
  }
  const findings: SkillSourceContextHealthFinding[] = [];
  for (const files of byChecksum.values()) {
    if (files.length < 2) {
      continue;
    }
    findings.push({
      kind: "reference_duplication",
      severity: "warning",
      skillId: input.skillId,
      snapshotId: input.snapshotId,
      title: "Duplicate skill references",
      message: `${input.skillId} has ${files.length} referenced files with the same checksum.`,
      evidence: files.map((file) => ({
        sourceRef: file.path,
        tokenEstimate: estimateTokensFromBytes(file.sizeBytes ?? 0),
        message: "This reference duplicates another referenced file by checksum.",
      })),
      recommendation: "Deduplicate references before compiling a lazy reference index.",
    });
  }
  return findings;
}

function mixedBodyTaxonomyFinding(input: BuildSkillSourceContextFindingsInput): SkillSourceContextHealthFinding | undefined {
  const body = stripFrontMatter(input.markdown);
  const evidence: SkillSourceContextFindingEvidence[] = [];
  for (const pattern of [
    { regex: /^#{1,6}\s+(background|context|overview)\b/imu, label: "background section" },
    { regex: /^#{1,6}\s+(examples?|sample|demo)\b/imu, label: "example section" },
    { regex: /^#{1,6}\s+(templates?|format|output)\b/imu, label: "template section" },
    { regex: /^#{1,6}\s+(references?|appendix|assets?)\b/imu, label: "reference section" },
  ]) {
    const match = pattern.regex.exec(body);
    if (match) {
      evidence.push({
        sourceRef: `SKILL.md:${lineNumber(body, match.index)}`,
        message: `Detected ${pattern.label} inside the default skill body.`,
      });
    }
  }
  const codeFenceCount = [...body.matchAll(/```/gu)].length / 2;
  if (codeFenceCount >= 3) {
    evidence.push({
      sourceRef: "SKILL.md",
      message: "The body contains multiple fenced examples or templates.",
    });
  }
  if (evidence.length < 2) {
    return undefined;
  }
  return {
    kind: "body_taxonomy_risk",
    severity: "warning",
    skillId: input.skillId,
    snapshotId: input.snapshotId,
    title: "Mixed skill body taxonomy",
    message: `${input.skillId} mixes core instructions with background, examples, templates, or references.`,
    evidence,
    recommendation: "Classify the body into core rules plus lazy references before enabling automatic runtime optimization.",
  };
}

function optimizationUnsafeFinding(input: BuildSkillSourceContextFindingsInput): SkillSourceContextHealthFinding | undefined {
  const unsafeWarnings = (input.warnings ?? []).filter((warning) =>
    warning.code === "secret_reference" ||
    warning.code === "external_send_claim" ||
    warning.code === "destructive_command" ||
    warning.code === "permission_like_instruction" ||
    warning.code === "unsupported_tool" ||
    warning.severity === "error"
  );
  const examplesWithRules = /(?:example|sample)[\s\S]{0,300}\b(must|never|always|required|do not|don't)\b/iu.test(input.markdown);
  if (unsafeWarnings.length === 0 && !examplesWithRules) {
    return undefined;
  }
  return {
    kind: "optimization_unsafe",
    severity: unsafeWarnings.some((warning) => warning.severity === "error" || warning.code === "secret_reference") ? "critical" : "warning",
    skillId: input.skillId,
    snapshotId: input.snapshotId,
    title: "Automatic optimization unsafe",
    message: `${input.skillId} needs manual review before automatic skill context optimization.`,
    evidence: [
      ...unsafeWarnings.map((warning) => ({
        sourceRef: warning.location ?? "SKILL.md",
        message: `${warning.code}: ${warning.message}`,
      })),
      ...(examplesWithRules ? [{
        sourceRef: "SKILL.md",
        message: "An example or sample section appears to contain normative rule language.",
      }] : []),
    ],
    recommendation: "Keep this skill on manual preview until unsafe claims and hidden rules are reviewed.",
  };
}

function findRoutingDescription(snapshot: SkillSourceSnapshot): string | undefined {
  return snapshot.agentMetadata?.shortDescription ?? parseFrontMatterDescription(snapshot.rawSkillMarkdown);
}

function parseFrontMatterDescription(markdown: string): string | undefined {
  const frontMatter = /^---\n([\s\S]*?)\n---/u.exec(markdown)?.[1];
  if (!frontMatter) {
    return undefined;
  }
  const singleLine = /^description:\s*["']?(.+?)["']?\s*$/imu.exec(frontMatter)?.[1];
  if (singleLine && singleLine !== "|" && singleLine !== ">") {
    return singleLine;
  }
  const block = /^description:\s*[|>]\s*\n((?:[ \t]+.+\n?)+)/imu.exec(frontMatter)?.[1];
  if (block) {
    return block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).join(" ");
  }
  return undefined;
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\s*/u, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isGenericDescription(description: string): boolean {
  const normalized = description.toLowerCase();
  return /^(use|run|execute|perform|handle|manage)\s+(this\s+)?(skill|workflow|task|process)\b/u.test(normalized) ||
    /^(review|test|implement|plan|design|operate)\.?$/u.test(normalized);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/u).length;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
