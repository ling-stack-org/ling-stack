import { createHash } from "node:crypto";
import { buildSkillSourceContextFindings } from "./skill-source-health.js";
import { parseSkillFrontMatter } from "./skill-source-definition.js";
import type {
  SkillCompiledRuntimeView,
  SkillCompiledSourceMapEntry,
  SkillDescriptionOptimization,
  SkillLazyReference,
  SkillLazyReferenceKind,
  SkillOptimizationAuthorityBoundary,
  SkillOptimizationMode,
  SkillOptimizationPreview,
  SkillOptimizationPreviewStatus,
  SkillOptimizationRisk,
  SkillSourceContextHealthFinding,
  SkillSourceFileRef,
  SkillSourceSnapshot,
} from "./skill-types.js";

export interface BuildSkillOptimizationPreviewInput {
  readonly snapshot: SkillSourceSnapshot;
  readonly mode?: SkillOptimizationMode;
  readonly generatedAt?: string;
}

interface MarkdownSection {
  readonly heading: string;
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
  readonly lazyKind?: SkillLazyReferenceKind;
}

const COMPILER_VERSION = "skill-reducer-preview-v1";
const authorityBoundary: SkillOptimizationAuthorityBoundary = {
  requiredToolsChanged: false,
  requiredProviderCapabilitiesChanged: false,
  approvalProfileChanged: false,
  teammateBindingsChanged: false,
};

export function buildSkillOptimizationPreview(input: BuildSkillOptimizationPreviewInput): SkillOptimizationPreview {
  const mode = input.mode ?? "preview_on_demand";
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const originalDescription = findRoutingDescription(input.snapshot);
  const contextFindings = buildSkillSourceContextFindings({
    skillId: input.snapshot.skillId,
    snapshotId: input.snapshot.id,
    markdown: input.snapshot.rawSkillMarkdown,
    referencedFiles: input.snapshot.referencedFiles,
    warnings: input.snapshot.warnings,
    routingDescription: originalDescription,
  });
  const risks = contextFindings.map(contextFindingRisk);
  const originalTokenEstimate = estimateOriginalTokens(input.snapshot);
  const routingDescription = buildRoutingDescriptionOptimization(input.snapshot, originalDescription, contextFindings);

  if (mode === "no_operation") {
    return {
      skillId: input.snapshot.skillId,
      sourceSnapshotId: input.snapshot.id,
      generatedAt,
      mode,
      status: "not_run",
      originalTokenEstimate,
      compiledTokenEstimate: originalTokenEstimate,
      routingDescription,
      risks,
      authorityBoundary,
    };
  }

  const compiledView = buildCompiledRuntimeView(input.snapshot, generatedAt);
  const status = previewStatus(risks);
  return {
    skillId: input.snapshot.skillId,
    sourceSnapshotId: input.snapshot.id,
    generatedAt,
    mode,
    status,
    originalTokenEstimate,
    compiledTokenEstimate: compiledView.tokenEstimate,
    routingDescription,
    compiledView,
    risks,
    authorityBoundary,
  };
}

function buildCompiledRuntimeView(snapshot: SkillSourceSnapshot, generatedAt: string): SkillCompiledRuntimeView {
  const sections = parseMarkdownSections(stripFrontMatter(snapshot.rawSkillMarkdown));
  const coreSections = sections.filter((section) => !section.lazyKind);
  const lazySections = sections.filter((section) => section.lazyKind);
  const coreRulesMarkdown = normalizeMarkdown(coreSections.map((section) => section.text).join("\n\n")) ||
    normalizeMarkdown(stripFrontMatter(snapshot.rawSkillMarkdown).slice(0, 12_000));
  const lazyReferences = [
    ...lazySections.map((section, index) => sectionLazyReference(section, index)),
    ...snapshot.referencedFiles.map((file, index) => fileLazyReference(file, lazySections.length + index)),
  ];
  const sourceMap: SkillCompiledSourceMapEntry[] = [
    {
      compiledRef: "coreRulesMarkdown",
      sourceRef: "SKILL.md",
      sourceStartLine: coreSections[0]?.line ?? 1,
      sourceEndLine: coreSections.at(-1)?.endLine,
      rationale: "Default runtime context keeps core instructions only.",
    },
    ...lazySections.map((section, index) => ({
      compiledRef: `lazyReferences.${index}`,
      sourceRef: `SKILL.md:${section.line}`,
      sourceStartLine: section.line,
      sourceEndLine: section.endLine,
      rationale: "Background, examples, templates, and references are deferred from default runtime context.",
    })),
    ...snapshot.referencedFiles.map((file, index) => ({
      compiledRef: `lazyReferences.${lazySections.length + index}`,
      sourceRef: file.path,
      rationale: "Referenced file remains lazy and does not grant authority.",
    })),
  ];
  const tokenEstimate = estimateTokens(coreRulesMarkdown) +
    lazyReferences.reduce((total, reference) => total + estimateTokens(`${reference.title}\n${reference.summary}`), 0);
  return {
    id: previewCompiledViewId(snapshot),
    skillId: snapshot.skillId,
    sourceSnapshotId: snapshot.id,
    createdAt: generatedAt,
    compilerVersion: COMPILER_VERSION,
    coreRulesMarkdown,
    lazyReferences,
    sourceMap,
    tokenEstimate,
    fallbackPolicy: "original_on_error",
  };
}

function parseMarkdownSections(markdown: string): readonly MarkdownSection[] {
  const lines = markdown.split(/\r?\n/u);
  const headingIndexes: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#{1,6}\s+\S/u.test(lines[index] ?? "")) {
      headingIndexes.push(index);
    }
  }
  if (headingIndexes.length === 0) {
    return [{
      heading: "Skill body",
      line: 1,
      endLine: lines.length,
      text: markdown,
    }];
  }
  const sections: MarkdownSection[] = [];
  const preamble = lines.slice(0, headingIndexes[0]).join("\n").trim();
  if (preamble) {
    sections.push({
      heading: "Preamble",
      line: 1,
      endLine: headingIndexes[0],
      text: preamble,
    });
  }
  for (let index = 0; index < headingIndexes.length; index += 1) {
    const start = headingIndexes[index] ?? 0;
    const end = headingIndexes[index + 1] ?? lines.length;
    const heading = (lines[start] ?? "").replace(/^#{1,6}\s+/u, "").trim() || "Section";
    const text = lines.slice(start, end).join("\n").trim();
    sections.push({
      heading,
      line: start + 1,
      endLine: end,
      text,
      lazyKind: lazyKindForHeading(heading),
    });
  }
  return sections;
}

function lazyKindForHeading(heading: string): SkillLazyReferenceKind | undefined {
  const normalized = heading.toLowerCase();
  if (/^(background|context|overview)\b/u.test(normalized)) {
    return "background";
  }
  if (/^(examples?|sample|demo)\b/u.test(normalized)) {
    return "example";
  }
  if (/^(templates?|format|output)\b/u.test(normalized)) {
    return "template";
  }
  if (/^(references?|appendix|assets?)\b/u.test(normalized)) {
    return "reference";
  }
  return undefined;
}

function sectionLazyReference(section: MarkdownSection, index: number): SkillLazyReference {
  return {
    id: `section-${index + 1}`,
    title: section.heading,
    kind: section.lazyKind ?? "reference",
    sourceRef: `SKILL.md:${section.line}`,
    summary: summarizeText(section.text),
    tokenEstimate: estimateTokens(section.text),
    loadPolicy: section.lazyKind === "example" || section.lazyKind === "template" ? "on_request" : "on_retry",
  };
}

function fileLazyReference(file: SkillSourceFileRef, index: number): SkillLazyReference {
  return {
    id: `file-${index + 1}`,
    title: file.path,
    kind: file.kind === "script" ? "script_note" : file.kind === "asset" ? "asset_note" : "reference",
    sourceRef: file.path,
    summary: `${file.kind} reference, ${file.sizeBytes ?? 0} bytes, checksum ${file.checksum ?? "unknown"}.`,
    tokenEstimate: estimateTokensFromBytes(file.sizeBytes ?? 0),
    loadPolicy: file.kind === "script" || file.kind === "asset" ? "never_auto" : "on_request",
  };
}

function contextFindingRisk(finding: SkillSourceContextHealthFinding): SkillOptimizationRisk {
  return {
    kind: finding.kind === "optimization_unsafe" ? "unsafe_source" : "context_health",
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    sourceRefs: finding.evidence.map((item) => item.sourceRef),
    blocksAutoRuntime: finding.severity === "critical" ||
      finding.kind === "optimization_unsafe" ||
      finding.kind === "source_snapshot_gap",
  };
}

function previewStatus(risks: readonly SkillOptimizationRisk[]): SkillOptimizationPreviewStatus {
  if (risks.some((risk) => risk.severity === "critical" || risk.blocksAutoRuntime)) {
    return "manual_review_required";
  }
  return risks.length > 0 ? "preview_ready" : "safe_for_auto_runtime";
}

function buildRoutingDescriptionOptimization(
  snapshot: SkillSourceSnapshot,
  original: string | undefined,
  findings: readonly SkillSourceContextHealthFinding[],
): SkillDescriptionOptimization | undefined {
  const weak = findings.some((finding) => finding.kind === "missing_or_weak_routing_description");
  if (!weak && !original) {
    return undefined;
  }
  return {
    original,
    suggested: weak ? suggestedRoutingDescription(snapshot) : original,
    reason: weak
      ? "Source health flagged the routing description as missing or too generic."
      : "Existing routing description is preserved.",
  };
}

function suggestedRoutingDescription(snapshot: SkillSourceSnapshot): string {
  const name = parseFrontMatterName(snapshot.rawSkillMarkdown) ?? snapshot.agentMetadata?.displayName ?? snapshot.skillId;
  return `Use when the task specifically calls for the ${name} skill workflow.`;
}

function findRoutingDescription(snapshot: SkillSourceSnapshot): string | undefined {
  return snapshot.agentMetadata?.shortDescription ?? parseFrontMatterDescription(snapshot.rawSkillMarkdown);
}

function parseFrontMatterName(markdown: string): string | undefined {
  return parseSkillFrontMatter(markdown).frontMatter.name;
}

function parseFrontMatterDescription(markdown: string): string | undefined {
  return parseSkillFrontMatter(markdown).frontMatter.description;
}

function estimateOriginalTokens(snapshot: SkillSourceSnapshot): number {
  return estimateTokens(snapshot.rawSkillMarkdown) +
    snapshot.referencedFiles.reduce((total, file) => total + estimateTokensFromBytes(file.sizeBytes ?? 0), 0);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function summarizeText(text: string): string {
  const normalized = text.replace(/^#{1,6}\s+/gmu, "").replace(/\s+/gu, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\s*/u, "");
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\n{3,}/gu, "\n\n").trim();
}

function previewCompiledViewId(snapshot: SkillSourceSnapshot): string {
  const digest = createHash("sha256").update(`${snapshot.id}:${snapshot.sourceChecksum}:${COMPILER_VERSION}`).digest("hex").slice(0, 16);
  return `skill_compiled_preview_${digest}`;
}
