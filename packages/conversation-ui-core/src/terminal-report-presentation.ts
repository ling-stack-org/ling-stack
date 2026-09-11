import { formatSynchronousCatalogMessage, type SupportedLocale } from "@ling-stack/localization";
import type { ConversationOperationSourceRef } from "./work-cell-view-model.js";
import type { ConversationTimelineTerminalReportItem } from "./transcript-item.js";
import { isUserVisibleTerminalReportArtifact, isUserVisibleTerminalReportSourceRef, userVisibleTerminalReportChanges } from "./terminal-report-visibility.js";

interface Section {
  readonly sourceRefs?: readonly ConversationOperationSourceRef[];
  readonly path?: string;
  readonly paths?: readonly string[];
}

interface ReportContent {
  readonly language?: SupportedLocale;
  readonly outcome: Section & {
    readonly status: "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
    readonly title: string;
    readonly summary: string;
    readonly corrections: readonly Section[];
  };
  readonly changes: readonly (Section & { readonly paths: readonly string[] })[];
  readonly verification: readonly Section[];
  readonly participants: readonly Section[];
  readonly artifacts: readonly (Section & { readonly id: string; readonly title: string; readonly path?: string })[];
  readonly risks: readonly Section[];
  readonly references: readonly ConversationOperationSourceRef[];
}

/** A DTO ref stays a display reference; privacy metadata never grants a Host capability. */
export function terminalReportSourceRefs(refs: readonly ConversationOperationSourceRef[]): readonly ConversationOperationSourceRef[] {
  return refs.map((ref) => ({
    kind: ref.kind, id: ref.id,
    ...(ref.label ? { label: ref.label } : {}),
    ...(ref.href ? { href: ref.href } : {}),
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.visibility ? { visibility: ref.visibility } : {}),
    ...(ref.sensitivity ? { sensitivity: ref.sensitivity } : {}),
  }));
}

function restricted(ref: ConversationOperationSourceRef): boolean {
  return ref.visibility === "developer_only" || ref.visibility === "audit" ||
    ref.visibility === "private" || ref.sensitivity === "secret_adjacent";
}

/**
 * Pure display/copy policy. Mixed evidence is withheld as a whole section, and
 * duplicate identities cannot strip stronger restrictions elsewhere in the report.
 * The durable report and completion facts are never modified.
 */
export function projectVisibleTerminalReportContent<T extends ReportContent>(report: T): T {
  const sections = [report.outcome, ...report.outcome.corrections, ...report.changes,
    ...report.verification, ...report.participants, ...report.artifacts, ...report.risks];
  const refs = [...report.references, ...sections.flatMap((section) => section.sourceRefs ?? [])];
  const key = (ref: ConversationOperationSourceRef): string => JSON.stringify([ref.kind, ref.id]);
  const hidden = new Set(refs.filter(restricted).map(key));
  const normalizePath = (path: string): string => path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const hiddenPaths = new Set(refs.filter((ref) => hidden.has(key(ref)) && (ref.kind === "file" || ref.kind === "path"))
    .flatMap((ref) => [ref.id, ...(ref.path ? [ref.path] : [])]).map(normalizePath));
  const visibleRef = (ref: ConversationOperationSourceRef): boolean => !hidden.has(key(ref)) && !restricted(ref);
  const visibleSection = (section: Section): boolean => (section.sourceRefs ?? []).every(visibleRef) &&
    [...(section.paths ?? []), ...(section.path ? [section.path] : [])].every((path) => !hiddenPaths.has(normalizePath(path)));
  const outcome = visibleSection(report.outcome) ? report.outcome : {
    ...report.outcome,
    title: formatSynchronousCatalogMessage(report.language ?? "en-US", `terminal_report.outcome.${report.outcome.status}`),
    summary: "",
    sourceRefs: [],
    corrections: [],
  };
  return {
    ...report,
    outcome: { ...outcome, corrections: outcome.corrections.filter(visibleSection) },
    changes: userVisibleTerminalReportChanges(report.changes.filter(visibleSection), refs),
    verification: report.verification.filter(visibleSection),
    participants: report.participants.filter(visibleSection),
    artifacts: report.artifacts.filter(visibleSection).filter(isUserVisibleTerminalReportArtifact),
    risks: report.risks.filter(visibleSection),
    references: report.references.filter(visibleRef).filter(isUserVisibleTerminalReportSourceRef),
  };
}

/** Apply the same content policy to already-typed channel and nested result rows. */
export function visibleTerminalReportTimelineItem(item: ConversationTimelineTerminalReportItem): ConversationTimelineTerminalReportItem {
  const content = projectVisibleTerminalReportContent({
    language: item.language,
    outcome: { status: item.outcomeStatus, title: item.title, summary: item.summary,
      corrections: item.corrections, sourceRefs: item.outcomeSourceRefs },
    changes: item.changes, verification: item.verification, participants: item.participants,
    artifacts: item.artifacts, risks: item.risks, references: item.references,
  });
  return {
    ...item,
    title: content.outcome.title, summary: content.outcome.summary, description: content.outcome.summary,
    outcomeSourceRefs: content.outcome.sourceRefs,
    corrections: content.outcome.corrections,
    changes: content.changes, changeCount: content.changes.length,
    verification: content.verification, verificationCount: content.verification.length,
    participants: content.participants, participantCount: content.participants.length,
    artifacts: content.artifacts, artifactCount: content.artifacts.length,
    risks: content.risks, riskCount: content.risks.length,
    references: content.references,
  };
}
