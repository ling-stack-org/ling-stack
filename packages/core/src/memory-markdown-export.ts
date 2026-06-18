import { redactSecrets } from "./redaction.js";
import type {
  MemoryObject,
  MemoryReviewDecision,
  MemorySelfImprovingMetadata,
  MemorySensitivity,
  MemoryReviewState,
  MemoryScopeType,
} from "./memory-types.js";

export interface MemoryMarkdownExportOptions {
  readonly workspaceId: string;
  readonly generatedAt?: string;
  readonly includeSecretAdjacent?: boolean;
  readonly title?: string;
}

export interface BuildMemoryMarkdownExportInput {
  readonly memories: readonly MemoryObject[];
  readonly latestDecisionsByMemoryId?: ReadonlyMap<string, MemoryReviewDecision | undefined>;
  readonly metadataByMemoryId?: ReadonlyMap<string, MemorySelfImprovingMetadata | undefined>;
  readonly options: MemoryMarkdownExportOptions;
}

export interface MemoryMarkdownExportItem {
  readonly id: string;
  readonly title: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly reviewState: MemoryReviewState;
  readonly sensitivity: MemorySensitivity;
  readonly confidence: MemoryReviewDecision["confidence"] | "unknown";
  readonly tagCount: number;
  readonly sourceRefCount: number;
  readonly redactionApplied: boolean;
}

export interface MemoryMarkdownExportResult {
  readonly schemaVersion: 1;
  readonly kind: "ling-memory-markdown-export";
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly suggestedFileName: string;
  readonly memoryCount: number;
  readonly skippedSecretAdjacentCount: number;
  readonly skippedSecretAdjacentIds: readonly string[];
  readonly redactionApplied: boolean;
  readonly items: readonly MemoryMarkdownExportItem[];
  readonly markdown: string;
}

export function buildMemoryMarkdownExport(input: BuildMemoryMarkdownExportInput): MemoryMarkdownExportResult {
  const generatedAt = input.options.generatedAt ?? new Date().toISOString();
  const includeSecretAdjacent = input.options.includeSecretAdjacent === true;
  const skippedSecretAdjacent = includeSecretAdjacent
    ? []
    : input.memories.filter((memory) => memory.sensitivity === "secret-adjacent");
  const exportedMemories = input.memories.filter((memory) => includeSecretAdjacent || memory.sensitivity !== "secret-adjacent");
  const sections: string[] = [];
  let redactionApplied = false;
  const items: MemoryMarkdownExportItem[] = [];

  for (const memory of exportedMemories) {
    const decision = input.latestDecisionsByMemoryId?.get(memory.id);
    const metadata = input.metadataByMemoryId?.get(memory.id);
    const redacted = redactMemoryExportPayload({ memory, decision, metadata });
    redactionApplied = redactionApplied || redacted.redactionApplied;
    const redactedMemory = redacted.payload.memory;
    const redactedDecision = redacted.payload.decision;
    const redactedMetadata = redacted.payload.metadata;
    const confidence = decision?.confidence ?? "unknown";
    items.push({
      id: redactedMemory.id,
      title: redactedMemory.title,
      scopeType: redactedMemory.scopeType,
      ownerId: redactedMemory.ownerId,
      reviewState: redactedMemory.reviewState,
      sensitivity: redactedMemory.sensitivity,
      confidence,
      tagCount: redactedMemory.tags.length,
      sourceRefCount: redactedMemory.sourceRefs.length,
      redactionApplied: redacted.redactionApplied,
    });

    const itemMetadata = {
      id: redactedMemory.id,
      workspaceId: redactedMemory.workspaceId,
      scopeType: redactedMemory.scopeType,
      ownerId: redactedMemory.ownerId,
      reviewState: redactedMemory.reviewState,
      sensitivity: redactedMemory.sensitivity,
      confidence,
      enabled: redactedMemory.enabled,
      verifyBeforeUse: redactedMemory.verifyBeforeUse,
      tags: redactedMemory.tags,
      sourceRefs: redactedMemory.sourceRefs,
      retrievalProviderId: redactedMemory.retrievalProviderId,
      retrievalHandle: redactedMemory.retrievalHandle,
      createdBy: redactedMemory.createdBy,
      createdAt: redactedMemory.createdAt,
      updatedAt: redactedMemory.updatedAt,
      lastUsedAt: redactedMemory.lastUsedAt,
      latestReviewDecision: redactedDecision,
      selfImprovingMetadata: redactedMetadata,
      redactionApplied: redacted.redactionApplied,
    };
    sections.push([
      `## ${escapeHeading(redactedMemory.title)}`,
      "",
      "### Metadata",
      fencedBlock("json", `${JSON.stringify(itemMetadata, null, 2)}\n`),
      "",
      "### Body",
      fencedBlock("text", `${redactedMemory.body}\n`),
    ].join("\n"));
  }

  const frontMatter = {
    schemaVersion: 1,
    product: "ling-stack",
    kind: "ling-memory-markdown-export",
    workspaceId: input.options.workspaceId,
    generatedAt,
    memoryCount: exportedMemories.length,
    skippedSecretAdjacentCount: skippedSecretAdjacent.length,
    redactionApplied,
    authority: "projection-only",
  };
  const title = input.options.title ?? "Ling Memory Export";
  const markdown = [
    "---",
    JSON.stringify(frontMatter, null, 2),
    "---",
    "",
    `# ${escapeHeading(title)}`,
    "",
    "> This Markdown file is a read-only projection of Ling memory. The resolved workspace SQLite database remains authoritative.",
    "",
    "## Summary",
    "",
    `- Generated at: ${generatedAt}`,
    `- Workspace id: ${input.options.workspaceId}`,
    `- Exported memories: ${exportedMemories.length}`,
    `- Skipped secret-adjacent memories: ${skippedSecretAdjacent.length}`,
    `- Redaction applied: ${redactionApplied ? "yes" : "no"}`,
    "",
    skippedSecretAdjacent.length > 0
      ? [
          "## Skipped Secret-Adjacent Memories",
          "",
          ...skippedSecretAdjacent.map((memory) => `- \`${memory.id}\` ${escapeInline(memory.title)}`),
          "",
        ].join("\n")
      : "",
    ...sections,
    "",
  ].filter((part) => part !== "").join("\n");

  return {
    schemaVersion: 1,
    kind: "ling-memory-markdown-export",
    workspaceId: input.options.workspaceId,
    generatedAt,
    suggestedFileName: createMemoryMarkdownExportFileName(input.options.workspaceId, generatedAt),
    memoryCount: exportedMemories.length,
    skippedSecretAdjacentCount: skippedSecretAdjacent.length,
    skippedSecretAdjacentIds: skippedSecretAdjacent.map((memory) => memory.id),
    redactionApplied,
    items,
    markdown,
  };
}

export function createMemoryMarkdownExportFileName(workspaceId: string, generatedAt: string): string {
  const safeWorkspaceId = workspaceId.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeTimestamp = generatedAt.replace(/[^0-9A-Za-z._-]/g, "-");
  return `memory-export-${safeWorkspaceId}-${safeTimestamp}.md`;
}

function redactMemoryExportPayload(input: {
  readonly memory: MemoryObject;
  readonly decision?: MemoryReviewDecision;
  readonly metadata?: MemorySelfImprovingMetadata;
}): {
  readonly payload: {
    readonly memory: MemoryObject;
    readonly decision?: MemoryReviewDecision;
    readonly metadata?: MemorySelfImprovingMetadata;
  };
  readonly redactionApplied: boolean;
} {
  const payload = {
    memory: input.memory,
    decision: input.decision,
    metadata: input.metadata,
  };
  const redacted = redactSecrets(payload) as typeof payload;
  return {
    payload: redacted,
    redactionApplied: JSON.stringify(redacted) !== JSON.stringify(payload),
  };
}

function fencedBlock(language: string, content: string): string {
  const longestFence = content.match(/`+/g)?.reduce((max, item) => Math.max(max, item.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${content}${fence}`;
}

function escapeHeading(value: string): string {
  return value.replace(/\r?\n/g, " ").trim() || "Untitled";
}

function escapeInline(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}
