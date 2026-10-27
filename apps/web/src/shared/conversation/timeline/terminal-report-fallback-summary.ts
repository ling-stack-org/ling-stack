import {
  isUserVisibleTerminalReportArtifact,
  visibleTerminalReportTimelineItem,
  type ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import { formatSynchronousCatalogMessage } from "@ling-stack/localization";
import { terminalReportCheckNeedsAttention, terminalReportDisplayPolicy, terminalReportRiskNeedsAttention } from "./terminal-report-display-policy.js";

/** Shared visible ending for the renderer and ordinary response clipboard. */
export function terminalReportFinalPresentation(input: ConversationTimelineTerminalReportItem, hasFinalNarration: boolean) {
  const item = visibleTerminalReportTimelineItem(input);
  const result = {
    item,
    ...terminalReportDisplayPolicy(item, hasFinalNarration),
    // Attention facts have their own compact entries below, not a second prose copy.
    summary: hasFinalNarration ? "" : fallbackSummary(item, false),
    corrections: item.corrections,
    verification: item.verification.filter(terminalReportCheckNeedsAttention),
    participants: item.participants.filter((participant) => participant.status !== "completed"),
    artifacts: item.artifacts.filter((artifact) => isUserVisibleTerminalReportArtifact(artifact) &&
      artifact.kind !== "file" && artifact.kind !== "diff" && artifact.kind !== "test_result"),
    risks: item.risks.filter(terminalReportRiskNeedsAttention),
  };
  const statusKey = result.needsAttention && item.status === "succeeded" ? "terminal_report.section.open_issues" :
    item.status === "succeeded" || item.status === "partially_succeeded" || item.status === "blocked" ||
    item.status === "failed" || item.status === "cancelled" ? `terminal_report.outcome.${item.status}` as const :
      item.status === "pending" ? "terminal_report.meta.pending" : "terminal_report.meta.unknown";
  return { ...result,
    statusLabel: formatSynchronousCatalogMessage(item.language ?? "en-US", statusKey),
    showStatus: result.needsAttention || result.corrections.length > 0 || result.verification.length > 0 ||
      result.participants.length > 0 || result.artifacts.length > 0 || result.risks.length > 0 || !result.summary,
  };
}

/** Localize structured result labels identically for the visible supplement and its copy. */
export function terminalReportResultMeta(item: ConversationTimelineTerminalReportItem, values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => Boolean(value)).map((value) => {
    const key = `terminal_report.meta.${value}` as const;
    const label = formatSynchronousCatalogMessage(item.language ?? "en-US", key);
    return label === key ? value : label;
  }).join(" · ");
}

/**
 * A report-only ending uses the same privacy-filtered facts as its details.
 * Host fallbacks additionally preview bounded delivery/check facts, never child
 * narration or raw command output. Model summaries are not expanded a second
 * time. Commands, output and duration belong to their original tool items.
 */
export function terminalReportFallbackSummary(input: ConversationTimelineTerminalReportItem): string {
  const item = visibleTerminalReportTimelineItem(input);
  return fallbackSummary(item, true);
}

function fallbackSummary(item: ConversationTimelineTerminalReportItem, includeAttention: boolean): string {
  const blocks = [item.summary];
  if (item.reportStatus === "fallback") {
    const language = item.language ?? "en-US";
    // Report changes may aggregate multiple files or lose internal paths during
    // privacy projection. Leave exact per-file totals to the existing diff UI;
    // never redistribute a change's aggregate totals across its visible paths.
    const files = [...new Set(item.changes.flatMap((change) => change.paths))]
      .filter((path) => path.trim()).slice(0, 4).map(previewCode);
    const checks = item.verification.filter((check) => check.title.trim() &&
      (includeAttention || !terminalReportCheckNeedsAttention(check))).slice(0, 4)
      .map((check) => `${previewCode(check.title)} — ${formatSynchronousCatalogMessage(language, `terminal_report.meta.${check.status}`)}`);
    if (files.length) blocks.push(`${formatSynchronousCatalogMessage(language, "terminal_report.section.changes")}: ${files.join("; ")}`);
    if (checks.length) blocks.push(`${formatSynchronousCatalogMessage(language, "terminal_report.section.verification")}: ${checks.join("; ")}`);
  }
  if (includeAttention && (item.outcomeStatus === "failed" || item.outcomeStatus === "cancelled" || item.outcomeStatus === "blocked")) {
    for (const risk of item.risks) {
      // Canonical display refs intentionally remove internal Run links. Host
      // interruption risk identities survive that projection; use these fixed
      // namespaces, never raw error text or inferred command/path content.
      const runLevel = risk.sourceRefs.some((ref) => ref.kind === "run") ||
        risk.id.startsWith("run-failure:") || risk.id.startsWith("execution-unconfirmed:");
      if (risk.severity !== "critical" || (risk.status !== "unresolved" && risk.status !== "unverified") || !runLevel) continue;
      blocks.push(risk.summary);
    }
  }
  return [...new Set(blocks.map((block) => block.trim()).filter(Boolean))].join("\n\n");
}

/** Host-visible paths/check titles remain literal even when they contain Markdown. */
function previewCode(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const text = line.length > 160 ? `${line.slice(0, 159)}…` : line;
  const fence = "`".repeat([...text.matchAll(/`+/gu)].reduce((size, match) => Math.max(size, match[0].length + 1), 1));
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
