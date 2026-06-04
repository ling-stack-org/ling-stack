import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  redactSecrets,
  type ArtifactType,
  type RunArtifact,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type { PiRunnerEvent } from "@ling-stack/runner-pi";
import { isPathInsideRoot, normalizeArtifactPath } from "../../shared/path.js";
import { isRecord } from "../../shared/validation.js";

const MAX_EXTRACTED_ARTIFACT_BYTES = 256 * 1024;
const MAX_EXTRACTED_ARTIFACTS_PER_TOOL = 6;

interface ExtractedArtifactCandidate {
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType?: string;
  readonly content?: string;
  readonly existingPath?: string;
}

export function persistExtractedArtifacts(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
  readonly nextIndex: () => number;
  readonly extraSecrets?: readonly (string | undefined)[];
}): RunArtifact[] {
  const candidates = extractArtifactCandidates(options);
  const artifacts: RunArtifact[] = [];
  for (const candidate of candidates.slice(0, MAX_EXTRACTED_ARTIFACTS_PER_TOOL)) {
    const artifact = materializeExtractedArtifact(options.store, options.run.id, candidate, options.nextIndex(), options.extraSecrets ?? []);
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

export function resolveArtifactContentPath(store: RunStore, artifact: RunArtifact): string {
  const artifactRoot = store.paths.artifactsDir;
  const absolutePath = isAbsolute(artifact.path) ? artifact.path : resolvePath(artifactRoot, artifact.path);
  const relativePath = relative(artifactRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact content path is outside .ling-stack/artifacts: ${artifact.path}`);
  }
  return absolutePath;
}

export function inferArtifactContentType(artifact: RunArtifact): string {
  return contentTypeForArtifactType(artifact.type);
}

function extractArtifactCandidates(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
}): ExtractedArtifactCandidate[] {
  const candidates: ExtractedArtifactCandidate[] = [];
  const addTextCandidate = (title: string, content: string, type?: ArtifactType): void => {
    if (!content.trim()) {
      return;
    }
    const artifactType = type ?? inferArtifactTypeFromText(content);
    candidates.push({
      type: artifactType,
      title,
      content,
      contentType: contentTypeForArtifactType(artifactType),
    });
  };

  collectToolResultTextCandidates(options.event).forEach((candidate) => addTextCandidate(candidate.title, candidate.content, candidate.type));

  const generatedPath = readInputString(options.sourceArgs, "path", "");
  if (options.event.toolName === "write") {
    const generatedContent = readInputString(options.sourceArgs, "content", "");
    if (generatedContent) {
      addTextCandidate(
        `Generated file content: ${generatedPath || options.event.toolCallId}`,
        generatedContent,
        inferArtifactTypeFromPath(generatedPath, generatedContent),
      );
    }
  }

  if (options.event.toolName === "edit") {
    const edits = readInputArray(options.sourceArgs, "edits");
    const hasDiffOutput = candidates.some((candidate) => candidate.type === "diff");
    if (edits.length > 0 && !hasDiffOutput) {
      addTextCandidate(`Generated edit diff: ${generatedPath || options.event.toolCallId}`, formatEditPreview(edits), "diff");
    }
  }

  for (const rawPath of collectGeneratedArtifactPaths(options.event, options.sourceArgs)) {
    const existingPath = resolveExistingArtifactPath(options.store.paths.artifactsDir, options.run.cwd, rawPath);
    if (existingPath) {
      const artifactType = inferArtifactTypeFromPath(existingPath);
      candidates.push({
        type: artifactType,
        title: `Generated file: ${basename(rawPath) || rawPath}`,
        existingPath,
        contentType: contentTypeForArtifactType(artifactType),
      });
    } else {
      candidates.push({
        type: "file",
        title: `Generated file metadata: ${rawPath}`,
        content: formatGeneratedFileMetadata(options.event, rawPath),
        contentType: contentTypeForArtifactType("file"),
      });
    }
  }

  return dedupeArtifactCandidates(candidates);
}

function collectToolResultTextCandidates(
  event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>,
): Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> {
  if (typeof event.result === "string") {
    return [{ title: `${event.toolName} output`, content: event.result, type: inferArtifactTypeFromText(event.result) }];
  }
  const result = event.result;
  if (!isRecord(result)) {
    return [];
  }

  const candidates: Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> = [];
  const addField = (key: string, title: string, type?: ArtifactType): void => {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push({ title, content: value, type: type ?? inferArtifactTypeFromText(value) });
      return;
    }
    const textContent = readToolResultTextContent(value);
    if (textContent.trim()) {
      candidates.push({ title, content: textContent, type: type ?? inferArtifactTypeFromText(textContent) });
    }
  };

  addField("diff", `${event.toolName} diff`, "diff");
  addField("patch", `${event.toolName} patch`, "diff");
  addField("unifiedDiff", `${event.toolName} diff`, "diff");
  addField("markdown", `${event.toolName} markdown`, "markdown");
  addField("stdout", `${event.toolName} stdout`, "log");
  addField("stderr", `${event.toolName} stderr`, "log");
  addField("log", `${event.toolName} log`, "log");
  addField("output", `${event.toolName} output`);
  addField("text", `${event.toolName} text`);
  addField("content", `${event.toolName} content`);
  return candidates;
}

function readToolResultTextContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      const type = item.type;
      const text = item.text;
      if ((type === undefined || type === "text") && typeof text === "string") {
        return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function collectGeneratedArtifactPaths(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, sourceArgs: unknown): string[] {
  const paths = new Set<string>();
  for (const path of collectPathLikeFields(event.result)) {
    paths.add(path);
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = readInputString(sourceArgs, "path", "");
    if (looksLikeFilePathString(path)) {
      paths.add(path);
    }
  }

  return [...paths];
}

function collectPathLikeFields(value: unknown, keyHint = ""): string[] {
  if (typeof value === "string") {
    return keyLooksLikePath(keyHint) && looksLikeFilePathString(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPathLikeFields(item, keyHint));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => collectPathLikeFields(item, key));
}

function keyLooksLikePath(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "filename" ||
    normalized === "files" ||
    normalized === "paths" ||
    normalized.endsWith("path") ||
    normalized.endsWith("file") ||
    normalized.endsWith("files") ||
    normalized.includes("outputpath") ||
    normalized.includes("outputfile") ||
    normalized.includes("artifactpath") ||
    normalized.includes("targetpath")
  );
}

function looksLikeFilePathString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes("\n") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return false;
  }
  return trimmed.includes("/") || trimmed.includes("\\") || extname(trimmed) !== "";
}

function resolveExistingArtifactPath(artifactRoot: string, cwd: string, rawPath: string): string | undefined {
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [resolvePath(artifactRoot, rawPath), resolvePath(cwd, rawPath)];

  for (const candidate of candidates) {
    const absolutePath = resolvePath(candidate);
    if (!isPathInsideRoot(artifactRoot, absolutePath)) {
      continue;
    }
    const stats = statFileIfPresent(absolutePath);
    if (stats?.isFile()) {
      return absolutePath;
    }
  }
  return undefined;
}

function materializeExtractedArtifact(
  store: RunStore,
  runId: string,
  candidate: ExtractedArtifactCandidate,
  index: number,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact | undefined {
  const createdAt = new Date().toISOString();

  if (candidate.existingPath) {
    if (!isPathInsideRoot(store.paths.artifactsDir, candidate.existingPath)) {
      return undefined;
    }
    const stats = statFileIfPresent(candidate.existingPath);
    if (!stats?.isFile()) {
      return undefined;
    }
    return store.createArtifact({
      runId,
      type: candidate.type,
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, candidate.existingPath)),
      title: candidate.title,
      contentType: candidate.contentType,
      sizeBytes: Number(stats.size),
      createdAt,
    });
  }

  if (candidate.content === undefined) {
    return undefined;
  }

  const runArtifactDir = resolvePath(store.paths.artifactsDir, runId);
  mkdirSync(runArtifactDir, { recursive: true });
  const relativePath = `${runId}/${formatArtifactFilename(index, candidate)}`;
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  const content = truncateExtractedArtifactContent(redactArtifactContent(candidate.content, extraSecrets));
  writeFileSync(absolutePath, content, "utf8");
  const stats = statSync(absolutePath);

  return store.createArtifact({
    runId,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType,
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function dedupeArtifactCandidates(candidates: readonly ExtractedArtifactCandidate[]): ExtractedArtifactCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}\0${candidate.title}\0${candidate.existingPath ?? candidate.content ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatArtifactFilename(index: number, candidate: ExtractedArtifactCandidate): string {
  const titleSlug = candidate.title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact";
  return `${String(index).padStart(3, "0")}-${titleSlug}.${artifactExtensionForType(candidate.type)}`;
}

function artifactExtensionForType(type: ArtifactType): string {
  if (type === "markdown") {
    return "md";
  }
  if (type === "diff") {
    return "diff";
  }
  if (type === "json") {
    return "json";
  }
  if (type === "log") {
    return "log";
  }
  if (type === "image") {
    return "png";
  }
  if (type === "video") {
    return "mp4";
  }
  return "txt";
}

function inferArtifactTypeFromPath(path: string, content = ""): ArtifactType {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".diff" || extension === ".patch") {
    return "diff";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".log" || extension === ".txt" || extension === ".out" || extension === ".err") {
    return "log";
  }
  if (content) {
    return inferArtifactTypeFromText(content);
  }
  return "file";
}

function inferArtifactTypeFromText(content: string): ArtifactType {
  if (isDiffLikeContent(content)) {
    return "diff";
  }
  if (isMarkdownLikeContent(content)) {
    return "markdown";
  }
  return "log";
}

function isDiffLikeContent(content: string): boolean {
  return /^diff --git /m.test(content) || /^--- .+\n\+\+\+ /m.test(content) || /^@@ /m.test(content);
}

function isMarkdownLikeContent(content: string): boolean {
  return /^#{1,6}\s+\S/m.test(content) || /```/.test(content) || /^\s*[-*]\s+\S/m.test(content);
}

function formatGeneratedFileMetadata(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, rawPath: string): string {
  return [
    `Generated file path: ${rawPath}`,
    `Source tool: ${event.toolName}`,
    `Tool call: ${event.toolCallId}`,
    "",
    "Content was not copied because artifact content is served only from .ling-stack/artifacts.",
  ].join("\n");
}

function redactArtifactContent(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}

function truncateExtractedArtifactContent(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_EXTRACTED_ARTIFACT_BYTES) {
    return content;
  }
  const truncated = Buffer.from(content, "utf8").subarray(0, MAX_EXTRACTED_ARTIFACT_BYTES).toString("utf8");
  return `${truncated}\n\n[truncated from ${bytes} bytes]`;
}

function statFileIfPresent(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function contentTypeForArtifactType(type: ArtifactType): string {
  if (type === "json") {
    return "application/json; charset=utf-8";
  }
  if (type === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (type === "diff") {
    return "text/x-diff; charset=utf-8";
  }
  if (type === "log" || type === "file") {
    return "text/plain; charset=utf-8";
  }
  if (type === "image") {
    return "image/png";
  }
  if (type === "video") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function formatEditPreview(edits: readonly unknown[]): string {
  if (edits.length === 0) {
    return "No edit preview was provided.";
  }
  return edits
    .map((edit, index) => {
      if (!isRecord(edit)) {
        return `#${index + 1}\n<invalid edit entry>`;
      }
      const oldText = readInputString(edit, "oldText", "");
      const newText = readInputString(edit, "newText", "");
      return `#${index + 1}\n- ${truncatePreview(oldText, 320)}\n+ ${truncatePreview(newText, 320)}`;
    })
    .join("\n\n");
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function truncatePreview(value: string, limit = 1_200): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
