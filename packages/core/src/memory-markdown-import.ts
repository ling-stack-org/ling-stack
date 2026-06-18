import type {
  CreateMemoryObjectInput,
  MemoryScopeType,
  MemorySensitivity,
  MemorySourceRef,
} from "./memory-types.js";
import { DEFAULT_WORKSPACE_ID } from "./workspace-types.js";

export interface MemoryMarkdownImportOptions {
  readonly workspaceId?: string;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly importedAt?: string;
  readonly limit?: number;
}

export interface MemoryMarkdownImportSource {
  readonly id: string;
  readonly label: string;
  readonly importedAt: string;
  readonly originalKind?: string;
  readonly originalWorkspaceId?: string;
}

export interface MemoryMarkdownImportCandidate {
  readonly index: number;
  readonly originalId?: string;
  readonly title: string;
  readonly createInput: CreateMemoryObjectInput;
  readonly warnings: readonly string[];
}

export interface MemoryMarkdownImportSkipped {
  readonly index: number;
  readonly title?: string;
  readonly reason: string;
}

export interface MemoryMarkdownImportPlan {
  readonly schemaVersion: 1;
  readonly kind: "ling-memory-markdown-import";
  readonly source: MemoryMarkdownImportSource;
  readonly candidateCount: number;
  readonly skippedCount: number;
  readonly candidates: readonly MemoryMarkdownImportCandidate[];
  readonly skipped: readonly MemoryMarkdownImportSkipped[];
}

const MEMORY_SCOPE_TYPES = new Set<MemoryScopeType>(["workspace", "channel", "teammate", "task", "run"]);
const MEMORY_SENSITIVITIES = new Set<MemorySensitivity>(["normal", "private", "secret-adjacent"]);
const MEMORY_SOURCE_TYPES = new Set<MemorySourceRef["type"]>([
  "manual",
  "message",
  "decision",
  "doc",
  "attachment",
  "run-event",
  "artifact",
  "import",
]);

export function parseMemoryMarkdownImport(markdown: string, options: MemoryMarkdownImportOptions = {}): MemoryMarkdownImportPlan {
  const importedAt = options.importedAt ?? new Date().toISOString();
  const frontMatter = parseFrontMatter(markdown);
  const source = buildImportSource(frontMatter.data, options, importedAt);
  const sections = extractMemorySections(frontMatter.body);
  const candidates: MemoryMarkdownImportCandidate[] = [];
  const skipped: MemoryMarkdownImportSkipped[] = [];

  for (const [sectionIndex, section] of sections.entries()) {
    const index = sectionIndex + 1;
    if (options.limit !== undefined && candidates.length >= options.limit) {
      skipped.push({ index, title: section.title, reason: "Import limit reached." });
      continue;
    }

    const metadataBlock = extractFencedBlockAfter(section.content, "### Metadata");
    const bodyBlock = extractFencedBlockAfter(section.content, "### Body");
    if (!metadataBlock || !bodyBlock) {
      skipped.push({ index, title: section.title, reason: "Section is missing Metadata or Body fenced block." });
      continue;
    }

    const metadata = parseJsonRecord(metadataBlock.content);
    if (!metadata) {
      skipped.push({ index, title: section.title, reason: "Metadata block must be valid JSON object." });
      continue;
    }

    const candidate = buildImportCandidate({
      index,
      title: section.title,
      metadata,
      body: trimSingleFinalNewline(bodyBlock.content),
      source,
      targetWorkspaceId: options.workspaceId ?? DEFAULT_WORKSPACE_ID,
    });
    if ("skipped" in candidate) {
      skipped.push(candidate.skipped);
      continue;
    }
    candidates.push(candidate.candidate);
  }

  return {
    schemaVersion: 1,
    kind: "ling-memory-markdown-import",
    source,
    candidateCount: candidates.length,
    skippedCount: skipped.length,
    candidates,
    skipped,
  };
}

function buildImportCandidate(input: {
  readonly index: number;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
  readonly body: string;
  readonly source: MemoryMarkdownImportSource;
  readonly targetWorkspaceId: string;
}): { readonly candidate: MemoryMarkdownImportCandidate } | { readonly skipped: MemoryMarkdownImportSkipped } {
  const title = input.title.trim();
  if (!title) {
    return { skipped: { index: input.index, reason: "Title must be non-empty." } };
  }
  if (!input.body.trim()) {
    return { skipped: { index: input.index, title, reason: "Body must be non-empty." } };
  }

  const scopeType = readStringUnion(input.metadata, "scopeType", MEMORY_SCOPE_TYPES);
  if (!scopeType) {
    return { skipped: { index: input.index, title, reason: "Metadata scopeType is missing or unsupported." } };
  }
  const ownerId = readNonEmptyString(input.metadata, "ownerId") ?? input.targetWorkspaceId;
  const sensitivity = readStringUnion(input.metadata, "sensitivity", MEMORY_SENSITIVITIES) ?? "normal";
  const originalId = readNonEmptyString(input.metadata, "id");
  const warnings: string[] = [];
  const sourceRefs = readMemorySourceRefs(input.metadata.sourceRefs, warnings);
  sourceRefs.push({
    type: "import",
    id: importSourceRefId(input.source.id, originalId ?? `section_${input.index}`),
    label: input.source.label,
  });

  warnIfAuthorityFieldPresent(input.metadata, warnings);
  const originalReviewState = readNonEmptyString(input.metadata, "reviewState");
  if (originalReviewState && originalReviewState !== "candidate") {
    warnings.push(`Original reviewState "${originalReviewState}" was imported as candidate.`);
  }
  const enabled = sensitivity === "secret-adjacent" ? false : true;
  const originalEnabled = input.metadata.enabled;
  if (typeof originalEnabled === "boolean" && originalEnabled !== enabled) {
    warnings.push("Original enabled flag was not restored.");
  }

  return {
    candidate: {
      index: input.index,
      originalId,
      title,
      createInput: {
        workspaceId: input.targetWorkspaceId,
        scopeType,
        ownerId,
        title,
        body: input.body,
        tags: normalizeStringList(input.metadata.tags),
        sourceRefs,
        reviewState: "candidate",
        enabled,
        sensitivity,
        verifyBeforeUse: sensitivity === "secret-adjacent" ? true : readBoolean(input.metadata, "verifyBeforeUse") ?? false,
        createdBy: "ling-stack memory import",
      },
      warnings,
    },
  };
}

function parseFrontMatter(markdown: string): { readonly data?: Record<string, unknown>; readonly body: string } {
  if (!markdown.startsWith("---\n")) {
    return { body: markdown };
  }
  const endIndex = markdown.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { body: markdown };
  }
  const jsonText = markdown.slice(4, endIndex).trim();
  const bodyStart = markdown.slice(endIndex + 4).startsWith("\n") ? endIndex + 5 : endIndex + 4;
  return {
    data: parseJsonRecord(jsonText),
    body: markdown.slice(bodyStart),
  };
}

function buildImportSource(
  frontMatter: Record<string, unknown> | undefined,
  options: MemoryMarkdownImportOptions,
  importedAt: string,
): MemoryMarkdownImportSource {
  const label = options.sourceLabel?.trim() || "Markdown memory import";
  return {
    id: sanitizeSourceId(options.sourceId ?? label),
    label,
    importedAt,
    originalKind: typeof frontMatter?.kind === "string" ? frontMatter.kind : undefined,
    originalWorkspaceId: typeof frontMatter?.workspaceId === "string" ? frontMatter.workspaceId : undefined,
  };
}

function extractMemorySections(markdown: string): Array<{ readonly title: string; readonly content: string }> {
  const headingPattern = /^## (.+)$/gm;
  const matches = [...markdown.matchAll(headingPattern)];
  const sections: Array<{ readonly title: string; readonly content: string }> = [];
  for (const [index, match] of matches.entries()) {
    const title = (match[1] ?? "").trim();
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end);
    if (content.includes("### Metadata") || content.includes("### Body")) {
      sections.push({ title, content });
    }
  }
  return sections;
}

function extractFencedBlockAfter(content: string, label: string): { readonly language: string; readonly content: string } | undefined {
  const labelIndex = content.indexOf(label);
  if (labelIndex === -1) {
    return undefined;
  }
  const afterLabel = content.slice(labelIndex + label.length);
  const match = /(?:^|\n)(`{3,})([^\n`]*)\n([\s\S]*?)\n\1(?=\n|$)/.exec(afterLabel);
  if (!match) {
    return undefined;
  }
  return {
    language: (match[2] ?? "").trim(),
    content: match[3] ?? "",
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readStringUnion<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  const value = readNonEmptyString(record, key);
  if (!value || !allowed.has(value as T)) {
    return undefined;
  }
  return value as T;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readMemorySourceRefs(value: unknown, warnings: string[]): MemorySourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: MemorySourceRef[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      warnings.push(`Dropped invalid sourceRefs[${index}].`);
      continue;
    }
    const type = item.type;
    const id = item.id;
    if (!MEMORY_SOURCE_TYPES.has(type as MemorySourceRef["type"]) || typeof id !== "string" || !id.trim()) {
      warnings.push(`Dropped invalid sourceRefs[${index}].`);
      continue;
    }
    refs.push({
      type: type as MemorySourceRef["type"],
      id: id.trim(),
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined,
      url: typeof item.url === "string" && item.url.trim() ? item.url.trim() : undefined,
    });
  }
  return refs;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    values.push(normalized);
  }
  return values;
}

function warnIfAuthorityFieldPresent(metadata: Record<string, unknown>, warnings: string[]): void {
  for (const key of ["retrievalProviderId", "retrievalHandle", "latestReviewDecision", "selfImprovingMetadata"]) {
    if (metadata[key] !== undefined && metadata[key] !== null) {
      warnings.push(`${key} was not imported.`);
    }
  }
}

function importSourceRefId(sourceId: string, itemId: string): string {
  return `${sourceId}#${sanitizeSourceId(itemId)}`;
}

function sanitizeSourceId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._:-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "memory-markdown-import";
}

function trimSingleFinalNewline(value: string): string {
  if (value.endsWith("\r\n")) {
    return value.slice(0, -2);
  }
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
