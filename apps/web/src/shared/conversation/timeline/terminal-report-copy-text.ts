import {
  isUserVisibleTerminalReportArtifact,
  projectVisibleTerminalReportContent,
  type ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import type { ConversationTimelineResponse } from "./timeline-response-presentation.js";

/** Copy the final fallback as well as commentary when no final model reply exists. */
export function timelineResponseCopyText(response: ConversationTimelineResponse, hasFinalNarration: boolean): string {
  if (!response.settled) return "";
  if (response.report && !hasFinalNarration) {
    return joinBlocks([response.copyText, terminalReportCopyText(response.report)]);
  }
  return response.copyText || (response.report ? terminalReportCopyText(response.report) : "");
}

/**
 * Serialize this report's visible final result, never the surrounding response.
 * The caller owns report selection and validation. This projection deliberately
 * reads reference policy for filtering but never serializes its identity or labels.
 * It reads no sibling item, child transcript, or raw evidence field, and preserves
 * Markdown prose rather than flattening it.
 */
export function terminalReportCopyText(input: ConversationTimelineTerminalReportItem): string {
  if (input.status !== "succeeded" && input.status !== "partially_succeeded" && input.status !== "failed" &&
    input.status !== "cancelled" && input.status !== "blocked") return "";

  const content = projectVisibleTerminalReportContent({
    language: input.language,
    outcome: { status: input.outcomeStatus, title: input.title, summary: input.summary,
      corrections: input.corrections, sourceRefs: input.outcomeSourceRefs },
    changes: input.changes, verification: input.verification, participants: input.participants,
    artifacts: input.artifacts, risks: input.risks, references: input.references,
  });
  const item = { ...content, title: content.outcome.title, summary: content.outcome.summary, corrections: content.outcome.corrections };

  // Match TerminalReportDetail: a lone successful participant adds no detail.
  const participants = item.participants.length > 1 || item.participants.some((participant) => participant.status !== "completed")
    ? item.participants
    : [];
  const artifacts = item.artifacts.filter(isUserVisibleTerminalReportArtifact);
  return joinBlocks([
    heading(item.title, 1),
    item.summary,
    section("Corrections", item.corrections.map((correction) => entry(
      correction.correctedFact,
      correction.confidence,
      `Previously: ${correction.originalAssumption}`,
    ))),
    section("Changes", item.changes.map((change) => entry(
      change.title,
      changeMeta(change.kind, change.addedLines, change.deletedLines),
      change.summary,
      pathsBlock(change.paths),
    ))),
    section("Verification", item.verification.map((verification) => entry(
      verification.title,
      [verification.status, durationLabel(verification.durationMs)].filter(Boolean).join(" · "),
      verification.summary,
      verification.command ? commandBlock(verification.command) : undefined,
    ))),
    section("Agents", participants.map((participant) => entry(
      participant.displayName,
      [participant.roleKey, participant.status].filter(Boolean).join(" · "),
      participant.contribution,
    ))),
    section("Artifacts", artifacts.map((artifact) => entry(
      artifact.title,
      changeMeta(artifact.kind, artifact.addedLines, artifact.deletedLines),
      artifact.summary,
      artifact.path ? pathsBlock([artifact.path]) : undefined,
    ))),
    section("Risks", item.risks.map((risk) => entry(
      risk.summary,
      [risk.severity, risk.status, risk.approvalDecision].filter(Boolean).join(" · "),
      risk.nextAction,
    ))),
  ]);
}

function joinBlocks(blocks: readonly (string | undefined)[]): string {
  return blocks.filter((block): block is string => Boolean(block?.trim())).join("\n\n");
}

function heading(title: string, level: 1 | 2 | 3): string {
  return title.trim() ? `${"#".repeat(level)} ${title.trim()}` : "";
}

function section(title: string, entries: readonly string[]): string {
  const body = joinBlocks(entries);
  return body ? joinBlocks([heading(title, 2), body]) : "";
}

function entry(title: string, meta: string, summary?: string, detail?: string): string {
  return joinBlocks([heading(title, 3), meta, summary, detail]);
}

function pathsBlock(paths: readonly string[]): string {
  return paths.filter((path) => path.trim()).map((path) => `- ${path}`).join("\n");
}

function changeMeta(kind: string, addedLines?: number, deletedLines?: number): string {
  return [kind, addedLines === undefined ? "" : `+${addedLines}`, deletedLines === undefined ? "" : `-${deletedLines}`]
    .filter(Boolean).join(" · ");
}

function durationLabel(durationMs?: number): string {
  if (durationMs === undefined) return "";
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(1)}s`;
}

/** A visible command may itself contain Markdown fences; never truncate it. */
function commandBlock(command: string): string {
  const fenceLength = [...command.matchAll(/`+/gu)]
    .reduce((length, match) => Math.max(length, match[0].length + 1), 3);
  const fence = "`".repeat(fenceLength);
  return `${fence}sh\n${command}\n${fence}`;
}
