import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { readOnlyRunTools, type RunTool } from "./approval-policy.js";
import type { ProviderCapability } from "./provider-types.js";
import type {
  AiTeammateRoleKey,
  CreateSkillSourceSnapshotInput,
  SkillAgentMetadata,
  SkillDefinition,
  SkillRegistryEntry,
  SkillSourceFileKind,
  SkillSourceFileRef,
  SkillSourceFrontMatter,
  SkillSourceKind,
  SkillSourceSemanticDiffItem,
  SkillSourceSemanticProfile,
  SkillSourceScanRoot,
  SkillSourceSnapshot,
  SkillSourceSyncDiffItem,
  SkillSourceSyncPreviewRecord,
  SkillSourceSyncPreviewReport,
  SkillSourceSyncRecordState,
  SkillSourceWarning,
  SkillSourceWarningCode,
  SkillWorkflowPhase,
} from "./skill-types.js";

export const MAX_SKILL_SOURCE_SNAPSHOT_BYTES = 256 * 1024;

export interface ResolveSkillSourceRootsInput {
  readonly workspaceRoot?: string;
  readonly homeDir?: string;
  readonly skillRoots?: readonly string[];
  readonly gstackRepoRoots?: readonly string[];
  readonly codexSkillRoots?: readonly string[];
  readonly includeDetectedRoots?: boolean;
}

export interface PreviewGstackSkillSourceSyncInput {
  readonly roots: readonly SkillSourceScanRoot[];
  readonly registrySkills: readonly SkillRegistryEntry[];
  readonly snapshots?: readonly SkillSourceSnapshot[];
  readonly includeSkillIds?: readonly string[];
  readonly excludeSkillIds?: readonly string[];
  readonly generatedAt?: string;
  readonly maxSourceBytes?: number;
}

interface DiscoveredSkillSource {
  readonly root: SkillSourceScanRoot;
  readonly skillDirectoryPath: string;
  readonly skillDirectoryName: string;
  readonly skillPath: string;
  readonly upstreamSkillPath: string;
  readonly markdown: string;
  readonly sourceChecksum: string;
  readonly sourceSizeBytes: number;
  readonly frontMatter: SkillSourceFrontMatter;
  readonly agentMetadata?: SkillAgentMetadata;
  readonly referencedFiles: readonly SkillSourceFileRef[];
  readonly warnings: readonly SkillSourceWarning[];
  readonly semanticProfile: SkillSourceSemanticProfile;
}

interface ParsedFrontMatter {
  readonly frontMatter: SkillSourceFrontMatter;
  readonly warnings: readonly SkillSourceWarning[];
}

const chatReasoningCapabilities = ["chat", "reasoning"] as const satisfies readonly ProviderCapability[];
const knownWorkflowPhases = new Set<SkillWorkflowPhase>([
  "discover",
  "plan",
  "design",
  "implement",
  "review",
  "test",
  "secure",
  "ship",
  "document",
  "operate",
]);

export async function resolveSkillSourceRoots(input: ResolveSkillSourceRootsInput = {}): Promise<SkillSourceScanRoot[]> {
  const home = input.homeDir ?? homedir();
  const candidates: SkillSourceScanRoot[] = [];

  for (const rootPath of input.skillRoots ?? []) {
    const resolvedRootPath = resolve(rootPath);
    candidates.push({
      id: hashedSkillSourceRootId("configured-skill-root", resolvedRootPath),
      rootPath: resolvedRootPath,
      sourceKind: "workspace-skill-directory",
      label: "Configured skill root",
    });
  }

  if (input.workspaceRoot) {
    const resolvedRootPath = resolve(input.workspaceRoot, ".agents", "skills");
    candidates.push({
      id: hashedSkillSourceRootId("workspace-skill-root", resolvedRootPath),
      rootPath: resolvedRootPath,
      sourceKind: "workspace-skill-directory",
      label: "Workspace skill root",
    });
  }

  for (const rootPath of input.gstackRepoRoots ?? []) {
    candidates.push(await gstackRootFromRepoPath(rootPath, hashedSkillSourceRootId("configured-gstack-root", rootPath)));
  }

  for (const rootPath of input.codexSkillRoots ?? []) {
    const resolvedRootPath = resolve(rootPath);
    candidates.push({
      id: hashedSkillSourceRootId("configured-codex-root", resolvedRootPath),
      rootPath: resolvedRootPath,
      sourceKind: "codex-skill-directory",
      label: "Configured Codex skill root",
    });
  }

  if (input.includeDetectedRoots !== false) {
    candidates.push(await gstackRootFromRepoPath(join(home, ".gstack", "repos", "gstack"), "local-gstack"));
    candidates.push({
      id: "codex-skills",
      rootPath: join(home, ".codex", "skills"),
      sourceKind: "codex-skill-directory",
      label: "Detected Codex skill root",
    });
    candidates.push({
      id: "agent-skills",
      rootPath: join(home, ".agents", "skills"),
      sourceKind: "codex-skill-directory",
      label: "Detected agent skill root",
    });
  }

  const unique = new Map<string, SkillSourceScanRoot>();
  for (const candidate of candidates) {
    const rootPath = resolve(candidate.rootPath);
    if (!unique.has(rootPath) && await isDirectory(rootPath)) {
      unique.set(rootPath, { ...candidate, rootPath });
    }
  }
  return [...unique.values()];
}

export async function previewGstackSkillSourceSync(input: PreviewGstackSkillSourceSyncInput): Promise<SkillSourceSyncPreviewReport> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const maxSourceBytes = Math.max(input.maxSourceBytes ?? MAX_SKILL_SOURCE_SNAPSHOT_BYTES, 1);
  const includeIds = input.includeSkillIds ? new Set(input.includeSkillIds) : undefined;
  const excludeIds = new Set(input.excludeSkillIds ?? []);
  const skillsById = new Map(input.registrySkills.map((skill) => [skill.id, skill]));
  const publishedSnapshots = (input.snapshots ?? []).filter((snapshot) => snapshot.reviewStatus === "published");
  const snapshotsBySkillId = new Map(publishedSnapshots.map((snapshot) => [snapshot.skillId, snapshot]));
  const records: SkillSourceSyncPreviewRecord[] = [];

  for (const root of input.roots) {
    for (const source of await scanSkillSourceRoot(root, maxSourceBytes)) {
      const skillId = resolveSkillIdForSource(source, skillsById);
      if (!isSkillIncluded(skillId, includeIds, excludeIds)) {
        continue;
      }
      const existingSkill = skillsById.get(skillId);
      const existingSnapshot = snapshotsBySkillId.get(skillId);
      const state = classifyDiscoveredSource(source, existingSkill, existingSnapshot);
      const definitionPreview = existingSkill?.definition ?? normalizeDefinitionFromSource(skillId, source);
      const snapshotPreview = buildSnapshotPreview(skillId, source, state);
      const diff = existingSnapshot && snapshotPreview ? buildSourceSyncDiff(existingSnapshot, source, snapshotPreview) : [];
      const semanticDiff = existingSnapshot
        ? diffSkillSourceSemanticProfiles(buildSkillSourceSemanticProfile({
            markdown: existingSnapshot.rawSkillMarkdown,
            sourceChecksum: existingSnapshot.sourceChecksum,
            referencedFiles: existingSnapshot.referencedFiles,
          }), source.semanticProfile)
        : [];
      records.push({
        state,
        skillId,
        sourceRootId: source.root.id,
        sourceKind: source.root.sourceKind,
        sourcePath: source.skillPath,
        upstreamName: source.root.upstreamName ?? source.frontMatter.name ?? source.skillDirectoryName,
        upstreamVersion: source.root.upstreamVersion,
        upstreamSkillPath: source.upstreamSkillPath,
        sourceChecksum: source.sourceChecksum,
        sourceSizeBytes: source.sourceSizeBytes,
        frontMatter: source.frontMatter,
        agentMetadata: source.agentMetadata,
        referencedFiles: source.referencedFiles,
        warnings: source.warnings,
        definitionPreview,
        snapshotPreview,
        existingSnapshotId: existingSnapshot?.id,
        diff,
        semanticProfile: source.semanticProfile,
        semanticDiff,
      });
    }
  }

  const discoveredSkillIds = new Set(records.map((record) => record.skillId));
  for (const snapshot of publishedSnapshots) {
    if (discoveredSkillIds.has(snapshot.skillId) || !isSkillIncluded(snapshot.skillId, includeIds, excludeIds)) {
      continue;
    }
    const state: SkillSourceSyncRecordState = skillsById.has(snapshot.skillId) ? "missing" : "orphaned";
    const warning: SkillSourceWarning = state === "missing"
      ? {
          code: "missing_upstream",
          severity: "warning",
          message: `${snapshot.skillId} has a published source snapshot, but no matching local source was discovered.`,
        }
      : {
          code: "orphaned_snapshot",
          severity: "warning",
          message: `${snapshot.id} points at missing or archived skill ${snapshot.skillId}.`,
        };
    records.push({
      state,
      skillId: snapshot.skillId,
      sourceKind: snapshot.sourceKind,
      sourcePath: snapshot.sourcePath,
      upstreamName: snapshot.upstreamName,
      upstreamVersion: snapshot.upstreamVersion,
      upstreamSkillPath: snapshot.upstreamSkillPath,
      sourceChecksum: snapshot.sourceChecksum,
      referencedFiles: snapshot.referencedFiles,
      warnings: [...snapshot.warnings, warning],
      existingSnapshotId: snapshot.id,
      diff: [],
      semanticDiff: [],
    });
  }

  records.sort((a, b) => a.skillId.localeCompare(b.skillId) || a.state.localeCompare(b.state));
  return {
    generatedAt,
    roots: input.roots,
    upstreamVersions: uniqueStrings(input.roots.flatMap((root) => root.upstreamVersion ? [root.upstreamVersion] : [])),
    summary: summarizeRecords(records),
    records,
  };
}

export function normalizeGstackSkillId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function gstackRootFromRepoPath(repoPath: string, id?: string): Promise<SkillSourceScanRoot> {
  const rootPath = resolve(repoPath, ".agents", "skills");
  return {
    id,
    rootPath,
    sourceKind: "gstack-skill-directory",
    label: "Detected gstack skill root",
    upstreamName: "gstack",
    upstreamVersion: await readGstackVersion(rootPath),
  };
}

function hashedSkillSourceRootId(prefix: string, rootPath: string): string {
  const digest = createHash("sha256").update(resolve(rootPath)).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

async function scanSkillSourceRoot(root: SkillSourceScanRoot, maxSourceBytes: number): Promise<DiscoveredSkillSource[]> {
  const rootPath = resolve(root.rootPath);
  if (!await isDirectory(rootPath)) {
    return [];
  }
  const directories = await listSkillDirectories(rootPath);
  const sources: DiscoveredSkillSource[] = [];
  for (const directoryPath of directories) {
    const skillPath = join(directoryPath, "SKILL.md");
    if (!await isFile(skillPath)) {
      continue;
    }
    sources.push(await readSkillSource({ ...root, rootPath }, directoryPath, skillPath, maxSourceBytes));
  }
  return sources;
}

async function listSkillDirectories(rootPath: string): Promise<string[]> {
  if (await isFile(join(rootPath, "SKILL.md"))) {
    return [rootPath];
  }
  const entries = await readdir(rootPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(rootPath, entry.name))
    .sort();
}

async function readSkillSource(
  root: SkillSourceScanRoot,
  directoryPath: string,
  skillPath: string,
  maxSourceBytes: number,
): Promise<DiscoveredSkillSource> {
  const bytes = await readFile(skillPath);
  const fullMarkdown = bytes.toString("utf8");
  const sourceSizeBytes = bytes.byteLength;
  const sourceChecksum = checksumBytes(bytes);
  const parsed = parseSkillFrontMatter(fullMarkdown);
  const warnings = [...parsed.warnings, ...classifySkillSourceWarnings(fullMarkdown, sourceSizeBytes, maxSourceBytes)];
  const markdown = sourceSizeBytes > maxSourceBytes ? fullMarkdown.slice(0, maxSourceBytes) : fullMarkdown;
  const agentMetadata = await readAgentMetadata(directoryPath, warnings);
  const referencedFiles = await inventoryReferencedFiles(directoryPath);
  const semanticProfile = buildSkillSourceSemanticProfile({
    markdown: fullMarkdown,
    sourceChecksum,
    referencedFiles,
  });
  return {
    root,
    skillDirectoryPath: directoryPath,
    skillDirectoryName: basename(directoryPath),
    skillPath,
    upstreamSkillPath: normalizeRelativePath(relative(root.rootPath, skillPath)),
    markdown,
    sourceChecksum,
    sourceSizeBytes,
    frontMatter: parsed.frontMatter,
    agentMetadata,
    referencedFiles,
    warnings,
    semanticProfile,
  };
}

function parseSkillFrontMatter(markdown: string): ParsedFrontMatter {
  const { frontMatter: frontMatterText } = splitMarkdownFrontMatter(markdown);
  if (!frontMatterText.trim()) {
    return {
      frontMatter: {},
      warnings: [{
        code: "missing_metadata",
        severity: "warning",
        message: "SKILL.md has no YAML front matter.",
        location: "SKILL.md",
      }],
    };
  }
  const document = parseDocument(frontMatterText);
  if (document.errors.length > 0) {
    return {
      frontMatter: {},
      warnings: [{
        code: "missing_metadata",
        severity: "warning",
        message: `SKILL.md front matter parse error: ${document.errors[0].message}`,
        location: "SKILL.md",
      }],
    };
  }
  const raw = document.toJSON();
  if (!isRecord(raw)) {
    return {
      frontMatter: {},
      warnings: [{
        code: "missing_metadata",
        severity: "warning",
        message: "SKILL.md front matter must be an object.",
        location: "SKILL.md",
      }],
    };
  }
  const parsedFrontMatter = {
    name: readOptionalString(raw.name),
    description: readOptionalString(raw.description),
  };
  const warnings: SkillSourceWarning[] = [];
  if (!parsedFrontMatter.name) {
    warnings.push({
      code: "missing_metadata",
      severity: "warning",
      message: "SKILL.md front matter is missing name.",
      location: "SKILL.md:name",
    });
  }
  if (!parsedFrontMatter.description) {
    warnings.push({
      code: "missing_metadata",
      severity: "info",
      message: "SKILL.md front matter is missing description.",
      location: "SKILL.md:description",
    });
  }
  return { frontMatter: parsedFrontMatter, warnings };
}

function splitMarkdownFrontMatter(markdown: string): { readonly frontMatter: string; readonly body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontMatter: "", body: normalized };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return { frontMatter: "", body: normalized };
  }
  const afterMarker = normalized.startsWith("\n", end + 4) ? end + 5 : end + 4;
  return {
    frontMatter: normalized.slice(4, end),
    body: normalized.slice(afterMarker),
  };
}

async function readAgentMetadata(directoryPath: string, warnings: SkillSourceWarning[]): Promise<SkillAgentMetadata | undefined> {
  const path = join(directoryPath, "agents", "openai.yaml");
  if (!await isFile(path)) {
    return undefined;
  }
  try {
    const text = await readFile(path, "utf8");
    const document = parseDocument(text);
    if (document.errors.length > 0) {
      warnings.push({
        code: "missing_metadata",
        severity: "warning",
        message: `agents/openai.yaml parse error: ${document.errors[0].message}`,
        location: "agents/openai.yaml",
      });
      return undefined;
    }
    const raw = document.toJSON();
    if (!isRecord(raw)) {
      return undefined;
    }
    const iface = readOptionalRecord(raw.interface);
    const policy = readOptionalRecord(raw.policy);
    return removeUndefined({
      displayName: readOptionalString(iface?.display_name) ?? readOptionalString(iface?.displayName),
      shortDescription: readOptionalString(iface?.short_description) ?? readOptionalString(iface?.shortDescription),
      defaultPrompt: readOptionalString(iface?.default_prompt) ?? readOptionalString(iface?.defaultPrompt),
      allowImplicitInvocation: readOptionalBoolean(policy?.allow_implicit_invocation) ?? readOptionalBoolean(policy?.allowImplicitInvocation),
    });
  } catch (error) {
    warnings.push({
      code: "missing_metadata",
      severity: "warning",
      message: `Failed to read agents/openai.yaml: ${errorMessage(error)}`,
      location: "agents/openai.yaml",
    });
    return undefined;
  }
}

async function inventoryReferencedFiles(directoryPath: string): Promise<SkillSourceFileRef[]> {
  const files: SkillSourceFileRef[] = [];
  for (const child of [
    { name: "scripts", kind: "script" as const },
    { name: "assets", kind: "asset" as const },
    { name: "references", kind: "reference" as const },
  ]) {
    const root = join(directoryPath, child.name);
    if (await isDirectory(root)) {
      for (const filePath of await listFilesRecursive(root)) {
        files.push(await fileRef(directoryPath, filePath, child.kind));
      }
    }
  }
  const agentMetadataPath = join(directoryPath, "agents", "openai.yaml");
  if (await isFile(agentMetadataPath)) {
    files.push(await fileRef(directoryPath, agentMetadataPath, "agent-metadata"));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function fileRef(skillDirectoryPath: string, filePath: string, kind: SkillSourceFileKind): Promise<SkillSourceFileRef> {
  const bytes = await readFile(filePath);
  return {
    path: normalizeRelativePath(relative(skillDirectoryPath, filePath)),
    kind,
    checksum: checksumBytes(bytes),
    sizeBytes: bytes.byteLength,
    includedInSnapshot: false,
  };
}

function classifySkillSourceWarnings(markdown: string, sourceSizeBytes: number, maxSourceBytes: number): SkillSourceWarning[] {
  const warnings: SkillSourceWarning[] = [];
  if (sourceSizeBytes > maxSourceBytes) {
    warnings.push({
      code: "large_source",
      severity: "warning",
      message: `SKILL.md is ${sourceSizeBytes} bytes, above the ${maxSourceBytes} byte snapshot cap.`,
      location: "SKILL.md",
    });
    warnings.push({
      code: "source_truncated",
      severity: "warning",
      message: "Preview source was truncated to the configured snapshot byte cap.",
      location: "SKILL.md",
    });
  }
  addPatternWarning(warnings, markdown, "secret_reference", rawSecretPattern(markdown) ? "error" : "warning", [
    /\b(secret|token|api[_ -]?key|credential|password|bearer|keychain|\.env)\b/i,
    /sk-[A-Za-z0-9_-]{20,}/,
    /ghp_[A-Za-z0-9_]{20,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
  ], rawSecretPattern(markdown) ? "Possible raw secret-like value appears in SKILL.md." : "SKILL.md references secrets, tokens, credentials, or local env files.");
  addPatternWarning(warnings, markdown, "external_send_claim", "warning", [
    /\b(external_send|send email|post (a )?(comment|reply)|create (a )?pull request|open (a )?PR|submit form|checkout flow)\b/i,
  ], "SKILL.md claims an external-send or mutating remote action.");
  addPatternWarning(warnings, markdown, "destructive_command", "warning", [
    /\brm\s+-rf\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+push\s+--force\b/i,
    /\bdrop\s+database\b/i,
    /\btruncate\s+table\b/i,
    /\bsudo\s+rm\b/i,
    /\bchmod\s+777\b/i,
  ], "SKILL.md includes destructive command language.");
  addPatternWarning(warnings, markdown, "host_specific_tool", "info", [
    /\bAskUserQuestion\b/,
    /\bExitPlanMode\b/,
    /\bCONDUCTOR_/,
    /\bCLAUDE\b/,
    /\$GSTACK_BIN\b/,
    /\bgstack-/,
  ], "SKILL.md references host-specific gstack or Claude runtime behavior.");
  addPatternWarning(warnings, markdown, "unsupported_tool", "warning", [
    /\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+\b/,
    /\bnative AUQ\b/i,
  ], "SKILL.md references a tool surface that Ling may not expose directly.");
  addPatternWarning(warnings, markdown, "permission_like_instruction", "info", [
    /\b(approval bypass|bypass approval|ignore approval|grant .*tool|allowedTools|disallowedTools|permission gate)\b/i,
  ], "SKILL.md contains permission-like language that must not override Ling policy.");
  return uniqueWarnings(warnings);
}

function addPatternWarning(
  warnings: SkillSourceWarning[],
  markdown: string,
  code: SkillSourceWarningCode,
  severity: SkillSourceWarning["severity"],
  patterns: readonly RegExp[],
  message: string,
): void {
  for (const pattern of patterns) {
    const line = findFirstMatchingLine(markdown, pattern);
    if (line !== undefined) {
      warnings.push({
        code,
        severity,
        message,
        location: `SKILL.md:${line}`,
      });
      return;
    }
  }
}

function classifyDiscoveredSource(
  source: DiscoveredSkillSource,
  existingSkill: SkillRegistryEntry | undefined,
  existingSnapshot: SkillSourceSnapshot | undefined,
): SkillSourceSyncRecordState {
  if (source.warnings.some((warning) => warning.severity === "error")) {
    return "blocked";
  }
  if (!existingSkill) {
    return "new";
  }
  if (!existingSnapshot) {
    return "attachable";
  }
  if (existingSnapshot.sourceChecksum !== source.sourceChecksum || warningFingerprint(existingSnapshot.warnings) !== warningFingerprint(source.warnings)) {
    return "drifted";
  }
  return "unchanged";
}

function buildSourceSyncDiff(
  existingSnapshot: SkillSourceSnapshot,
  source: DiscoveredSkillSource,
  snapshotPreview: CreateSkillSourceSnapshotInput,
): SkillSourceSyncDiffItem[] {
  const existingFrontMatter = parseSkillFrontMatter(existingSnapshot.rawSkillMarkdown).frontMatter;
  const diff: SkillSourceSyncDiffItem[] = [];
  addDiffItem(diff, "sourceChecksum", "Checksum", existingSnapshot.sourceChecksum, snapshotPreview.sourceChecksum, "warning");
  addDiffItem(diff, "upstreamVersion", "Upstream version", existingSnapshot.upstreamVersion, snapshotPreview.upstreamVersion, "info");
  addDiffItem(diff, "upstreamSkillPath", "Skill path", existingSnapshot.upstreamSkillPath, snapshotPreview.upstreamSkillPath, "info");
  addDiffItem(diff, "sourceLengthChars", "Source length", String(existingSnapshot.rawSkillMarkdown.length), String(snapshotPreview.rawSkillMarkdown.length), "info");
  addDiffItem(diff, "referencedFiles", "Referenced files", summarizeFileRefs(existingSnapshot.referencedFiles), summarizeFileRefs(snapshotPreview.referencedFiles ?? []), "info");
  addDiffItem(diff, "warnings", "Warnings", summarizeWarnings(existingSnapshot.warnings), summarizeWarnings(snapshotPreview.warnings ?? []), "warning");
  addDiffItem(diff, "frontMatterName", "Front matter name", existingFrontMatter.name, source.frontMatter.name, "info");
  addDiffItem(diff, "frontMatterDescription", "Front matter description", firstLine(existingFrontMatter.description ?? ""), firstLine(source.frontMatter.description ?? ""), "info");
  addDiffItem(diff, "agentDisplayName", "Agent display name", existingSnapshot.agentMetadata?.displayName, source.agentMetadata?.displayName, "info");
  addDiffItem(diff, "agentShortDescription", "Agent short description", firstLine(existingSnapshot.agentMetadata?.shortDescription ?? ""), firstLine(source.agentMetadata?.shortDescription ?? ""), "info");
  addDiffItem(
    diff,
    "agentAllowImplicitInvocation",
    "Implicit invocation",
    formatOptionalBoolean(existingSnapshot.agentMetadata?.allowImplicitInvocation),
    formatOptionalBoolean(source.agentMetadata?.allowImplicitInvocation),
    "info",
  );
  return diff;
}

export function buildSkillSourceSemanticProfile(input: {
  readonly markdown: string;
  readonly sourceChecksum: string;
  readonly referencedFiles?: readonly SkillSourceFileRef[];
}): SkillSourceSemanticProfile {
  const { frontMatter, body } = splitMarkdownFrontMatter(input.markdown);
  const parsed = frontMatter.trim() ? parseSkillFrontMatter(input.markdown).frontMatter : {};
  const sections = extractMarkdownSections(body);
  return removeUndefined({
    sourceChecksum: input.sourceChecksum,
    title: parsed.name ?? sections[0]?.heading,
    description: parsed.description,
    sections,
    workflowVerbs: uniqueSortedClaims(extractClaims(input.markdown, workflowVerbPatterns)),
    stopGateCount: countPattern(input.markdown, /\b(STOP|approval gate|ask for approval|ask the user|confirm before|requires confirmation)\b/gi),
    approvalGateClaims: uniqueSortedClaims(extractClaims(input.markdown, approvalGatePatterns)),
    toolClaims: uniqueSortedClaims(extractClaims(input.markdown, toolClaimPatterns)),
    hostClaims: uniqueSortedClaims(extractClaims(input.markdown, hostClaimPatterns)),
    externalActionClaims: uniqueSortedClaims(extractClaims(input.markdown, externalActionPatterns)),
    destructiveClaims: uniqueSortedClaims(extractClaims(input.markdown, destructiveClaimPatterns)),
    secretClaims: uniqueSortedClaims(extractClaims(input.markdown, secretClaimPatterns)),
    referencedFileKinds: countReferencedFileKinds(input.referencedFiles ?? []),
  });
}

export function diffSkillSourceSemanticProfiles(
  before: SkillSourceSemanticProfile,
  after: SkillSourceSemanticProfile,
): SkillSourceSemanticDiffItem[] {
  const diff: SkillSourceSemanticDiffItem[] = [];
  addSemanticDiff(diff, {
    kind: "copy_change",
    severity: "info",
    before: summarizeOptional(before.title),
    after: summarizeOptional(after.title),
    message: "Skill title changed.",
  });
  addSemanticDiff(diff, {
    kind: "copy_change",
    severity: "info",
    before: summarizeOptional(firstLine(before.description ?? "")),
    after: summarizeOptional(firstLine(after.description ?? "")),
    message: "Skill description changed.",
  });
  addSemanticDiff(diff, {
    kind: "workflow_change",
    severity: "warning",
    before: summarizeSections(before.sections),
    after: summarizeSections(after.sections),
    message: "Workflow headings changed.",
  });
  addSemanticDiff(diff, {
    kind: "workflow_change",
    severity: "warning",
    before: before.workflowVerbs.join(", "),
    after: after.workflowVerbs.join(", "),
    message: "Workflow action vocabulary changed.",
  });
  addSemanticDiff(diff, {
    kind: "gate_change",
    severity: "warning",
    before: String(before.stopGateCount),
    after: String(after.stopGateCount),
    message: "STOP or approval gate count changed.",
  });
  addSemanticDiff(diff, {
    kind: "gate_change",
    severity: "warning",
    before: before.approvalGateClaims.join(", "),
    after: after.approvalGateClaims.join(", "),
    message: "Approval gate claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "tool_claim_change",
    severity: "warning",
    before: before.toolClaims.join(", "),
    after: after.toolClaims.join(", "),
    message: "Tool claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "host_claim_change",
    severity: "warning",
    before: before.hostClaims.join(", "),
    after: after.hostClaims.join(", "),
    message: "Host/runtime claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "external_action_change",
    severity: "warning",
    before: before.externalActionClaims.join(", "),
    after: after.externalActionClaims.join(", "),
    message: "External action claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "destructive_claim_change",
    severity: "error",
    before: before.destructiveClaims.join(", "),
    after: after.destructiveClaims.join(", "),
    message: "Destructive command claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "secret_claim_change",
    severity: "error",
    before: before.secretClaims.join(", "),
    after: after.secretClaims.join(", "),
    message: "Secret or credential claims changed.",
  });
  addSemanticDiff(diff, {
    kind: "referenced_file_change",
    severity: "warning",
    before: summarizeReferencedFileKinds(before.referencedFileKinds),
    after: summarizeReferencedFileKinds(after.referencedFileKinds),
    message: "Referenced file inventory changed.",
  });
  return diff;
}

const workflowVerbPatterns = [
  /\b(plan|design|implement|review|test|ship|deploy|document|investigate|benchmark|monitor|rollback|upgrade|sync|publish)\b/gi,
] as const;

const approvalGatePatterns = [
  /\b(STOP|approval gate|ask for approval|ask the user|confirm before|requires confirmation|manual review)\b/gi,
] as const;

const toolClaimPatterns = [
  /\b(bash|shell|filesystem|computer-use|browser|playwright|apply_patch|mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+|git|gh)\b/gi,
] as const;

const hostClaimPatterns = [
  /\b(CLAUDE|CONDUCTOR|Codex|gstack|AskUserQuestion|ExitPlanMode|GSTACK_BIN|MCP)\b/g,
] as const;

const externalActionPatterns = [
  /\b(send email|post (?:a )?(?:comment|reply)|create (?:a )?(?:pull request|PR)|submit form|checkout flow|deploy|release|publish)\b/gi,
] as const;

const destructiveClaimPatterns = [
  /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+push\s+--force|drop\s+database|truncate\s+table|sudo\s+rm|chmod\s+777)\b/gi,
] as const;

const secretClaimPatterns = [
  /\b(secret|token|api[_ -]?key|credential|password|bearer|keychain|\.env)\b/gi,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9_]{20,}/g,
] as const;

function extractMarkdownSections(markdown: string): SkillSourceSemanticProfile["sections"] {
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      return [];
    }
    return [{
      heading: match[2].trim(),
      level: match[1].length,
      line: index + 1,
    }];
  });
}

function extractClaims(markdown: string, patterns: readonly RegExp[]): string[] {
  const claims: string[] = [];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const value = match[0]?.trim();
      if (value) {
        claims.push(value.toLowerCase());
      }
    }
  }
  return claims;
}

function uniqueSortedClaims(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function countPattern(markdown: string, pattern: RegExp): number {
  return [...markdown.matchAll(pattern)].length;
}

function countReferencedFileKinds(files: readonly SkillSourceFileRef[]): Record<SkillSourceFileKind, number> {
  const counts: Record<SkillSourceFileKind, number> = {
    script: 0,
    asset: 0,
    reference: 0,
    "agent-metadata": 0,
    other: 0,
  };
  for (const file of files) {
    counts[file.kind] += 1;
  }
  return counts;
}

function addSemanticDiff(diff: SkillSourceSemanticDiffItem[], item: SkillSourceSemanticDiffItem): void {
  const before = normalizeDiffValue(item.before);
  const after = normalizeDiffValue(item.after);
  if (before === after) {
    return;
  }
  diff.push(removeUndefined({
    ...item,
    before,
    after,
  }));
}

function summarizeSections(sections: readonly SkillSourceSemanticProfile["sections"][number][]): string {
  if (sections.length === 0) {
    return "0 headings";
  }
  const headings = sections.map((section) => `${section.level}:${section.heading}`).join("|");
  return `${sections.length} headings · ${checksumBytes(Buffer.from(headings)).slice(0, 19)}`;
}

function summarizeReferencedFileKinds(counts: Readonly<Record<SkillSourceFileKind, number>>): string {
  return (["script", "asset", "reference", "agent-metadata", "other"] as const)
    .map((kind) => `${kind}:${counts[kind] ?? 0}`)
    .join(", ");
}

function summarizeOptional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function addDiffItem(
  diff: SkillSourceSyncDiffItem[],
  field: SkillSourceSyncDiffItem["field"],
  label: string,
  before: string | undefined,
  after: string | undefined,
  severity: SkillSourceSyncDiffItem["severity"],
): void {
  const normalizedBefore = normalizeDiffValue(before);
  const normalizedAfter = normalizeDiffValue(after);
  if (normalizedBefore === normalizedAfter) {
    return;
  }
  diff.push(removeUndefined({
    field,
    label,
    before: normalizedBefore,
    after: normalizedAfter,
    severity,
  }));
}

function normalizeDiffValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function summarizeFileRefs(files: readonly SkillSourceFileRef[]): string {
  if (files.length === 0) {
    return "0 files";
  }
  const fingerprint = files.map((file) => `${file.path}:${file.checksum ?? ""}`).sort().join("|");
  return `${files.length} files · ${checksumBytes(Buffer.from(fingerprint)).slice(0, 19)}`;
}

function summarizeWarnings(warnings: readonly SkillSourceWarning[]): string {
  if (warnings.length === 0) {
    return "0 warnings";
  }
  return `${warnings.length} warnings · ${warningFingerprint(warnings).slice(0, 48)}`;
}

function formatOptionalBoolean(value: boolean | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? "true" : "false";
}

function buildSnapshotPreview(
  skillId: string,
  source: DiscoveredSkillSource,
  state: SkillSourceSyncRecordState,
): CreateSkillSourceSnapshotInput | undefined {
  if (state === "blocked" || state === "missing" || state === "orphaned") {
    return undefined;
  }
  return removeUndefined({
    skillId,
    sourceKind: source.root.sourceKind,
    sourcePath: source.skillPath,
    upstreamName: source.root.upstreamName ?? source.frontMatter.name ?? source.skillDirectoryName,
    upstreamVersion: source.root.upstreamVersion,
    upstreamSkillPath: source.upstreamSkillPath,
    sourceChecksum: source.sourceChecksum,
    rawSkillMarkdown: source.markdown,
    agentMetadata: source.agentMetadata,
    referencedFiles: source.referencedFiles,
    warnings: source.warnings,
    reviewStatus: "draft" as const,
  });
}

function resolveSkillIdForSource(source: DiscoveredSkillSource, skillsById: ReadonlyMap<string, SkillRegistryEntry>): string {
  const rawCandidates = uniqueStringsPreserveOrder([
    source.frontMatter.name,
    source.skillDirectoryName,
    source.frontMatter.name ? `gstack-${source.frontMatter.name}` : undefined,
  ].filter((value): value is string => Boolean(value)).map(normalizeGstackSkillId));
  for (const candidate of rawCandidates) {
    if (skillsById.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of rawCandidates) {
    if (candidate.startsWith("gstack-")) {
      const stripped = candidate.slice("gstack-".length);
      if (skillsById.has(stripped)) {
        return stripped;
      }
    }
  }
  return rawCandidates[0] ?? normalizeGstackSkillId(source.skillDirectoryName);
}

function normalizeDefinitionFromSource(skillId: string, source: DiscoveredSkillSource): SkillDefinition {
  const summary = source.frontMatter.description ?? source.agentMetadata?.shortDescription ?? `Source-backed skill imported from ${source.skillDirectoryName}.`;
  const workflowPhase = inferWorkflowPhase(skillId, summary);
  return {
    id: skillId,
    name: source.frontMatter.name ?? source.agentMetadata?.displayName ?? titleizeSkillId(skillId),
    summary: firstLine(summary),
    roleAffinity: inferRoleAffinity(skillId, workflowPhase),
    workflowPhase,
    promptFragments: [summary],
    requiredTools: inferRequiredTools(source),
    requiredProviderCapabilities: chatReasoningCapabilities,
    approvalProfile: source.warnings.some((warning) => warning.code === "destructive_command" || warning.code === "external_send_claim")
      ? { mode: "strict", risk: "high", requiredForTools: ["bash", "edit", "write"], requiredForActions: ["external_send", "deploy"] }
      : source.warnings.some((warning) => warning.code === "host_specific_tool" || warning.code === "unsupported_tool")
        ? { mode: "standard", risk: "medium", requiredForTools: ["bash"] }
        : { mode: "none" },
    stateEffects: workflowPhase === "plan"
      ? ["creates_plan", "updates_plan"]
      : workflowPhase === "ship"
        ? ["prepares_release"]
        : [],
  };
}

function inferWorkflowPhase(skillId: string, summary: string): SkillWorkflowPhase {
  const text = `${skillId} ${summary}`.toLowerCase();
  const explicitPhase = [...knownWorkflowPhases].find((phase) => text.includes(phase));
  if (explicitPhase) {
    return explicitPhase;
  }
  if (text.includes("qa") || text.includes("test")) {
    return "test";
  }
  if (text.includes("security") || text.includes("cso")) {
    return "secure";
  }
  if (text.includes("deploy") || text.includes("ship") || text.includes("release") || text.includes("land")) {
    return "ship";
  }
  if (text.includes("doc")) {
    return "document";
  }
  if (text.includes("design")) {
    return "design";
  }
  if (text.includes("review") || text.includes("investigate") || text.includes("health")) {
    return "review";
  }
  if (text.includes("office") || text.includes("discover")) {
    return "discover";
  }
  if (text.includes("plan") || text.includes("spec")) {
    return "plan";
  }
  return "operate";
}

function inferRoleAffinity(skillId: string, phase: SkillWorkflowPhase): readonly AiTeammateRoleKey[] {
  if (phase === "design") {
    return ["designer"];
  }
  if (phase === "secure") {
    return ["security"];
  }
  if (phase === "ship") {
    return ["release"];
  }
  if (phase === "document") {
    return ["docs"];
  }
  if (phase === "test" || skillId.includes("qa")) {
    return ["qa"];
  }
  if (phase === "discover" || phase === "plan") {
    return ["product", "architect"];
  }
  return ["custom"];
}

function inferRequiredTools(source: DiscoveredSkillSource): readonly RunTool[] {
  const tools = new Set<RunTool>(readOnlyRunTools);
  if (source.warnings.some((warning) => warning.code === "host_specific_tool" || warning.code === "destructive_command")) {
    tools.add("bash");
  }
  if (source.markdown.includes("apply_patch") || /\b(edit|write)\b/i.test(source.markdown)) {
    tools.add("edit");
    tools.add("write");
  }
  return [...tools];
}

async function readGstackVersion(skillRootPath: string): Promise<string | undefined> {
  let current = resolve(skillRootPath);
  for (let index = 0; index < 6; index += 1) {
    const packageJsonPath = join(current, "package.json");
    if (await isFile(packageJsonPath)) {
      try {
        const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
        if (isRecord(raw) && readOptionalString(raw.name) === "gstack") {
          return readOptionalString(raw.version);
        }
      } catch {
        return undefined;
      }
    }
    const next = dirname(current);
    if (next === current) {
      return undefined;
    }
    current = next;
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function checksumBytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rawSecretPattern(markdown: string): boolean {
  return /sk-[A-Za-z0-9_-]{20,}/.test(markdown) || /ghp_[A-Za-z0-9_]{20,}/.test(markdown) || /xox[baprs]-[A-Za-z0-9-]{20,}/.test(markdown);
}

function findFirstMatchingLine(markdown: string, pattern: RegExp): number | undefined {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      return index + 1;
    }
  }
  return undefined;
}

function warningFingerprint(warnings: readonly SkillSourceWarning[]): string {
  return warnings
    .map((warning) => `${warning.code}:${warning.severity}:${warning.location ?? ""}`)
    .sort()
    .join("|");
}

function summarizeRecords(records: readonly SkillSourceSyncPreviewRecord[]): SkillSourceSyncPreviewReport["summary"] {
  return {
    totalRecords: records.length,
    attachable: records.filter((record) => record.state === "attachable").length,
    unchanged: records.filter((record) => record.state === "unchanged").length,
    drifted: records.filter((record) => record.state === "drifted").length,
    new: records.filter((record) => record.state === "new").length,
    missing: records.filter((record) => record.state === "missing").length,
    blocked: records.filter((record) => record.state === "blocked").length,
    orphaned: records.filter((record) => record.state === "orphaned").length,
  };
}

function isSkillIncluded(skillId: string, includeIds: ReadonlySet<string> | undefined, excludeIds: ReadonlySet<string>): boolean {
  if (includeIds && !includeIds.has(skillId)) {
    return false;
  }
  return !excludeIds.has(skillId);
}

function uniqueWarnings(warnings: readonly SkillSourceWarning[]): SkillSourceWarning[] {
  const seen = new Set<string>();
  const result: SkillSourceWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.severity}:${warning.location ?? ""}:${warning.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(warning);
    }
  }
  return result;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniqueStringsPreserveOrder(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function firstLine(value: string): string {
  const line = value.trim().split(/\r?\n/).find((item) => item.trim());
  return line?.trim() ?? "";
}

function titleizeSkillId(skillId: string): string {
  return skillId.split("-").filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
