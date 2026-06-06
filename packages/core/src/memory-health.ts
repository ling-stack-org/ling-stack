import type {
  MemoryObject,
  MemoryReviewDecision,
  MemoryScopeType,
  MemorySelfImprovingMetadata,
} from "./memory-types.js";

export type MemoryHealthSeverity = "info" | "warning" | "critical";

export type MemoryHealthFindingKind =
  | "missing_source_refs"
  | "expired_candidate"
  | "volatile_without_verify_before_use"
  | "duplicate_candidate"
  | "superseded_active_memory"
  | "secret_adjacent_recallable"
  | "authority_changing_claim"
  | "stale_candidate"
  | "high_review_backlog";

export interface MemoryHealthFinding {
  readonly id: string;
  readonly kind: MemoryHealthFindingKind;
  readonly severity: MemoryHealthSeverity;
  readonly memoryId?: string;
  readonly title: string;
  readonly message: string;
  readonly recommendation: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly reviewState?: MemoryObject["reviewState"];
  readonly sensitivity?: MemoryObject["sensitivity"];
  readonly sourceRefCount?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MemoryHealthSummary {
  readonly total: number;
  readonly active: number;
  readonly candidate: number;
  readonly disabled: number;
  readonly archived: number;
  readonly rejected: number;
  readonly enabled: number;
  readonly reviewBacklog: number;
  readonly staleCandidates: number;
  readonly verifyBeforeUse: number;
  readonly findings: {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
}

export interface MemoryHealthReport {
  readonly generatedAt: string;
  readonly staleCandidateDays: number;
  readonly summary: MemoryHealthSummary;
  readonly findings: readonly MemoryHealthFinding[];
}

export interface BuildMemoryHealthReportInput {
  readonly memories: readonly MemoryObject[];
  readonly latestDecisionsByMemoryId?: ReadonlyMap<string, MemoryReviewDecision | undefined>;
  readonly metadataByMemoryId?: ReadonlyMap<string, MemorySelfImprovingMetadata | undefined>;
  readonly generatedAt: string;
  readonly staleCandidateDays?: number;
  readonly backlogWarningThreshold?: number;
  readonly limit?: number;
}

const DEFAULT_STALE_CANDIDATE_DAYS = 30;
const DEFAULT_BACKLOG_WARNING_THRESHOLD = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const VOLATILE_MEMORY_PATTERN =
  /\b(port|process|pid|branch|provider|model|deploy|deployment|service|status|gateway|runtime|token|cookie|session|version|today|yesterday|tomorrow|latest|current)\b/i;
const AUTHORITY_CHANGING_PATTERN =
  /\b(permission|tool|mcp|provider|deploy|deployment|credential|secret|token|key|external[- ]?send|github|slack|linear)\b[\s\S]{0,120}\b(grant|allow|bypass|auto[- ]?approve|disable|force|push|merge|delete|ship|deploy|send)\b/i;

export function buildMemoryHealthReport(input: BuildMemoryHealthReportInput): MemoryHealthReport {
  const generatedAt = input.generatedAt;
  const staleCandidateDays = Math.max(input.staleCandidateDays ?? DEFAULT_STALE_CANDIDATE_DAYS, 1);
  const backlogWarningThreshold = Math.max(input.backlogWarningThreshold ?? DEFAULT_BACKLOG_WARNING_THRESHOLD, 1);
  const generatedTime = Date.parse(generatedAt);
  const staleBefore = Number.isFinite(generatedTime) ? generatedTime - staleCandidateDays * MS_PER_DAY : undefined;
  const findings: MemoryHealthFinding[] = [];
  const metadataByMemoryId = input.metadataByMemoryId ?? new Map<string, MemorySelfImprovingMetadata | undefined>();

  const counts = {
    active: 0,
    candidate: 0,
    disabled: 0,
    archived: 0,
    rejected: 0,
    enabled: 0,
    staleCandidates: 0,
    verifyBeforeUse: 0,
  };
  const duplicateCandidates = new Map<string, MemoryObject[]>();

  for (const memory of input.memories) {
    counts[memory.reviewState] += 1;
    if (memory.enabled) {
      counts.enabled += 1;
    }
    if (memory.verifyBeforeUse) {
      counts.verifyBeforeUse += 1;
    }
    if (memory.reviewState === "candidate") {
      const duplicateKey = normalizeDuplicateKey(memory);
      duplicateCandidates.set(duplicateKey, [...(duplicateCandidates.get(duplicateKey) ?? []), memory]);
    }

    const metadata = metadataByMemoryId.get(memory.id);
    if (memory.sourceRefs.length === 0) {
      findings.push(memoryFinding(memory, "missing_source_refs", "warning", "Missing source evidence", "This memory has no source references.", "Keep it as a candidate until source evidence is attached."));
    }
    if (memory.reviewState === "candidate" && staleBefore !== undefined && Date.parse(memory.createdAt) < staleBefore) {
      counts.staleCandidates += 1;
      findings.push(memoryFinding(memory, "stale_candidate", "warning", "Stale memory candidate", `Candidate has waited more than ${staleCandidateDays} days for review.`, "Approve, edit, reject, or quarantine it from the promotion inbox."));
    }
    if (memory.reviewState === "candidate" && metadata?.validUntil && Date.parse(metadata.validUntil) < generatedTime) {
      findings.push(memoryFinding(memory, "expired_candidate", "warning", "Expired memory candidate", "Candidate metadata is past its valid-until date.", "Reject it or refresh the evidence before approval."));
    }
    if (isRecallable(memory) && VOLATILE_MEMORY_PATTERN.test(memoryText(memory)) && !memory.verifyBeforeUse) {
      findings.push(memoryFinding(memory, "volatile_without_verify_before_use", "warning", "Volatile memory is directly recallable", "This memory appears environment- or time-sensitive but does not require verification before use.", "Enable verify-before-use or demote it for review."));
    }
    if (isRecallable(memory) && memory.sensitivity === "secret-adjacent") {
      findings.push(memoryFinding(memory, "secret_adjacent_recallable", "critical", "Secret-adjacent memory is recallable", "Secret-adjacent memory is active and enabled.", "Quarantine it or disable recall until reviewed."));
    }
    if (isRecallable(memory) && AUTHORITY_CHANGING_PATTERN.test(memoryText(memory))) {
      findings.push(memoryFinding(memory, "authority_changing_claim", "critical", "Authority-changing memory is recallable", "This memory appears to affect tools, credentials, deploys, or external sends.", "Require manual review and verification before using it as operational authority."));
    }
    if (metadata?.supersededBy && isRecallable(memory)) {
      findings.push(memoryFinding(memory, "superseded_active_memory", "warning", "Superseded memory is still recallable", `This memory is superseded by ${metadata.supersededBy}.`, "Disable or archive the superseded memory."));
    }
  }

  for (const duplicates of duplicateCandidates.values()) {
    if (duplicates.length < 2) {
      continue;
    }
    for (const memory of duplicates) {
      findings.push(memoryFinding(memory, "duplicate_candidate", "info", "Duplicate memory candidate", "Another candidate has the same scope, title, and body.", "Review one canonical candidate and reject the duplicate."));
    }
  }

  const reviewBacklog = input.memories.filter((memory) => memory.reviewState === "candidate" || memory.reviewState === "disabled").length;
  if (reviewBacklog >= backlogWarningThreshold) {
    findings.push({
      id: "memory-health:review-backlog",
      kind: "high_review_backlog",
      severity: "warning",
      title: "High memory review backlog",
      message: `${reviewBacklog} memory items are waiting for review or quarantine handling.`,
      recommendation: "Clear the promotion inbox before enabling broader fan-in experiments.",
    });
  }

  const sortedFindings = findings
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, Math.max(input.limit ?? 100, 1));

  return {
    generatedAt,
    staleCandidateDays,
    summary: {
      total: input.memories.length,
      active: counts.active,
      candidate: counts.candidate,
      disabled: counts.disabled,
      archived: counts.archived,
      rejected: counts.rejected,
      enabled: counts.enabled,
      reviewBacklog,
      staleCandidates: counts.staleCandidates,
      verifyBeforeUse: counts.verifyBeforeUse,
      findings: {
        critical: findings.filter((finding) => finding.severity === "critical").length,
        warning: findings.filter((finding) => finding.severity === "warning").length,
        info: findings.filter((finding) => finding.severity === "info").length,
      },
    },
    findings: sortedFindings,
  };
}

function memoryFinding(
  memory: MemoryObject,
  kind: MemoryHealthFindingKind,
  severity: MemoryHealthSeverity,
  title: string,
  message: string,
  recommendation: string,
): MemoryHealthFinding {
  return {
    id: `memory-health:${kind}:${memory.id}`,
    kind,
    severity,
    memoryId: memory.id,
    title,
    message,
    recommendation,
    scopeType: memory.scopeType,
    ownerId: memory.ownerId,
    reviewState: memory.reviewState,
    sensitivity: memory.sensitivity,
    sourceRefCount: memory.sourceRefs.length,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function isRecallable(memory: MemoryObject): boolean {
  return memory.enabled && memory.reviewState === "active";
}

function memoryText(memory: MemoryObject): string {
  return `${memory.title}\n${memory.body}\n${memory.tags.join("\n")}\n${memory.sourceRefs.map((ref) => ref.label ?? "").join("\n")}`;
}

function normalizeDuplicateKey(memory: MemoryObject): string {
  return [
    memory.scopeType,
    memory.ownerId,
    normalizeMemoryText(memory.title),
    normalizeMemoryText(memory.body),
  ].join("\u0000");
}

function normalizeMemoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function severityRank(severity: MemoryHealthSeverity): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}
