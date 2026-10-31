import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const timelineCssUrl = new URL("../src/styles/shared/conversation-timeline.css", import.meta.url);
const timelineSourceUrl = new URL("../src/shared/conversation/timeline/ConversationTimeline.tsx", import.meta.url);
const factRowSourceUrl = new URL("../src/shared/conversation/timeline/TimelineFactRow.tsx", import.meta.url);
const messageSourceUrl = new URL("../src/shared/conversation/timeline/ConversationTimelineMessageRenderer.tsx", import.meta.url);
const terminalReportSourceUrl = new URL("../src/shared/conversation/timeline/ConversationTimelineTerminalReportRenderer.tsx", import.meta.url);
const dockWorkspaceFileSourceUrl = new URL("../src/features/workspace/right-dock/DockFileItemDetail.tsx", import.meta.url);

test("typed timeline keeps the feed as the only vertical scroll owner", async () => {
  const styles = await readFile(timelineCssUrl, "utf8");
  assert.match(styles, /\[data-conversation-timeline="true"\][^{]*\{[^}]*overflow:\s*visible;/su);
  assert.match(styles, /\.conversation-timeline-output\s*\{[^}]*overflow:\s*visible;/su);
  assert.doesNotMatch(styles, /\.conversation-(?:command|exploration)-batch[^}]*overflow-y:\s*(?:auto|scroll)/su);
});

// The 2026-10-27 execution-detail ownership design supersedes the older full-report ending.
test("terminal result retains actionable supplements while Dock keeps viewer semantics", async () => {
  const [terminalReport, dockWorkspaceFile] = await Promise.all([
    readFile(terminalReportSourceUrl, "utf8"),
    readFile(dockWorkspaceFileSourceUrl, "utf8"),
  ]);
  for (const section of ["Corrections", "Verification", "Agents", "Artifacts", "Risks"]) {
    assert.equal(terminalReport.includes(`title="${section}"`), true);
  }
  for (const section of ["Changes", "Sources"]) assert.equal(terminalReport.includes(`title="${section}"`), false);
  assert.doesNotMatch(terminalReport, /Execution details|verification\.command|durationMs|showSummary/u);
  assert.match(dockWorkspaceFile, /capabilityTarget === "open_artifact"/u);
  assert.match(dockWorkspaceFile, /capabilityTarget === "open_diff" && preview\.kind !== "diff"/u);
  assert.match(dockWorkspaceFile, /data-workspace-viewer-kind="artifact"/u);
});

test("terminal report formats participant narration and separates mixed metadata from file links", async () => {
  const source = await readFile(terminalReportSourceUrl, "utf8");
  assert.match(source, /<MessageBodyRenderer\s+className="conversation-timeline-terminal-entry-summary"\s+text=\{summary\}/u);
  assert.match(source, /<details className="conversation-timeline-terminal-entry-sources"/u);
  assert.match(source, /<summary>\{t\("Sources"\)\} · \{lineage\.length\}<\/summary>/u);
  assert.match(source, /terminalReportSourceRefGroups\(refs\)/u);
  assert.match(source, /className="conversation-timeline-terminal-lineage-ref"/u);
  assert.match(source, /text=\{summary\}\s+cwd=\{cwd\}/u);
});

test("status-only terminal reports have no empty disclosure or duplicate response owner", async () => {
  const source = await readFile(terminalReportSourceUrl, "utf8");
  assert.match(source, /presentation\.showStatus \? <TimelineFactRow/u);
  assert.match(source, /statusLabel=""/u);
  assert.match(source, /meta=""/u);
  assert.doesNotMatch(source, /MessageActionBar/u, "TerminalReport must not own a second response action bar");
  assert.match(source, /detail=\{hasDetail \? <TerminalReportResultSupplement/u);
  assert.match(source, /terminalReportFinalPresentation\(inputItem, hasNarration\)/u);
});

test("every typed row exposes the stable renderer key semantic attribute", async () => {
  const [timeline, factRow, message] = await Promise.all([
    readFile(timelineSourceUrl, "utf8"),
    readFile(factRowSourceUrl, "utf8"),
    readFile(messageSourceUrl, "utf8"),
  ]);
  assert.match(factRow, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\(item\.kind\)\}/u);
  assert.match(message, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\(item\.kind\)\}/u);
  assert.match(timeline, /data-conversation-timeline-renderer-key=\{conversationTimelineRendererKey\("subAgentActivity"\)\}/u);
});

test("model message paths remain display-only and cannot invoke Host file callbacks", async () => {
  const message = await readFile(messageSourceUrl, "utf8");
  assert.match(message, /<LocalFileLink reference=\{reference\} \/>/u);
  assert.doesNotMatch(message, /onOpenSourceRef/u);
  assert.doesNotMatch(message, /trustedFileSourceRefForPath/u);
});
