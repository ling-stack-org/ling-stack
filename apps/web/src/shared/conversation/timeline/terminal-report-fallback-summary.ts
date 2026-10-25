import {
  visibleTerminalReportTimelineItem,
  type ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import { formatSynchronousCatalogMessage } from "@ling-stack/localization";

/**
 * A report-only ending uses the same privacy-filtered facts as its details.
 * Host fallbacks additionally preview bounded delivery/check facts, never child
 * narration or raw command output. Model summaries are not expanded a second
 * time. The durable report, complete details and copy projection stay intact.
 */
export function terminalReportFallbackSummary(input: ConversationTimelineTerminalReportItem): string {
  const item = visibleTerminalReportTimelineItem(input);
  const blocks = [item.summary];
  if (item.reportStatus === "fallback") {
    const language = item.language ?? "en-US";
    // Report changes may aggregate multiple files or lose internal paths during
    // privacy projection. Leave exact per-file totals to the existing diff UI;
    // never redistribute a change's aggregate totals across its visible paths.
    const files = [...new Set(item.changes.flatMap((change) => change.paths))]
      .filter((path) => path.trim()).slice(0, 4).map(previewCode);
    const checks = item.verification.filter((check) => (check.command || check.title).trim()).slice(0, 4)
      .map((check) => `${previewCode(check.command || check.title)} — ${formatSynchronousCatalogMessage(language, `terminal_report.meta.${check.status}`)}`);
    if (files.length) blocks.push(`${formatSynchronousCatalogMessage(language, "terminal_report.section.changes")}: ${files.join("; ")}`);
    if (checks.length) blocks.push(`${formatSynchronousCatalogMessage(language, "terminal_report.section.verification")}: ${checks.join("; ")}`);
  }
  if (item.outcomeStatus === "failed" || item.outcomeStatus === "cancelled" || item.outcomeStatus === "blocked") {
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

/** Host-visible paths/commands remain literal even when they contain Markdown. */
function previewCode(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const text = line.length > 160 ? `${line.slice(0, 159)}…` : line;
  const fence = "`".repeat([...text.matchAll(/`+/gu)].reduce((size, match) => Math.max(size, match[0].length + 1), 1));
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
