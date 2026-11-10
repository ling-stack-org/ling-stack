import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { isDelegatedOutcomeV1 } from "@ling-stack/contracts";
import * as conversationUiCore from "@ling-stack/conversation-ui-core";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (/^\.{1,2}\//.test(specifier) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });

const { projectWorkflowChildTimeline } = await import("../src/lib/workflow-child-timeline.ts");
const { hasWorkflowTimelineContent } = await import("../src/lib/workflow-timeline-content.ts");
const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");
const { conversationTimelineItemsForModel } = await import("../src/lib/conversation-work-cell.ts");
const { hasFinalTimelineResponseNarration, projectTimelineResponsePresentation } = await import(
  "../src/shared/conversation/timeline/timeline-response-presentation.ts");
const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false, logLevel: "silent", server: { middlewareMode: true } });
after(() => vite.close());
const { timelineResponseCopyText } = await vite.ssrLoadModule("/src/shared/conversation/timeline/terminal-report-copy-text.ts");
const { ConversationTimelineProtocolRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineProtocolRenderer.tsx");
const { ConversationTimelineTerminalReportRenderer } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/ConversationTimelineTerminalReportRenderer.tsx");

function fixture() {
  const model = { status: "blocked", task: "synthetic-qa", proposal: {
    command: "node synthetic/validate.cjs", cwd: ".", readPaths: ["synthetic/validate.cjs"], writePaths: [], network: false,
  }, reason: "AGENT_UNVERIFIED_REASON: cannot inspect /synthetic/input.cjs; **not Markdown**.",
  missingCapabilities: ["Read only the entry file"], verification: {
    entryFileRead: false, commandExecuted: false, toolsCalled: false, dependencyRequirement: "Not verified",
  }, decision: "No execution, no writes and no network; not verified." };
  const raw = ` \n${JSON.stringify(model, null, 2)}\n `;
  const outcome = { kind: "blocked", workflowId: "workflow", workflowStepId: "step", participantId: "qa",
    code: "required_operation_evidence_missing", reason: "HOST_REASON: missing command evidence",
    missingRequirements: ["validate"], evidenceRefs: [], lineage: {
      workflowId: "workflow", workflowStepId: "step", participantId: "qa", runId: "run", attemptId: "attempt",
      sourceRefs: [{ type: "workflow", id: "workflow" }, { type: "workflow_step", id: "step" },
        { type: "run", id: "run" }, { type: "attempt", id: "attempt" }],
    } };
  const segment = { content: raw, firstEventId: "event-1", lastEventId: "event-8", startEventSequence: 1,
    endEventSequence: 8, completed: true };
  const step = { id: "step", workspaceId: "workspace", channelId: "channel", workflowId: "workflow", position: 0,
    runId: "run", toParticipantId: "qa", toParticipantLabel: "QA", status: "blocked", title: "Validate", prompt: "Validate",
    createdAt: "time", updatedAt: "time", metadata: { delegatedOutcome: outcome, sourceMessageId: "source" },
    runNarration: { runId: "run", attemptId: "attempt", participantId: "qa", workflowStepId: "step",
      threadId: "parent-thread", turnId: "turn", sourceItemId: "source", sourceItemSequence: 1, segments: [segment] } };
  return { model, raw, outcome, segment, step,
    input: { steps: [step], rows: [], actions: [], participantId: "qa", parentItemId: "source" } };
}
function report(overrides = {}) {
  return { id: "report", kind: "terminalReport", reportId: "report", turnId: "turn", runId: "run",
    revision: 1, generation: 1, threadSequence: 1, partIndex: 0, status: "blocked", outcomeStatus: "blocked",
    title: "Task blocked", summary: "HOST_FINAL_FALLBACK: command was not verified", outcomeSourceRefs: [], sourceRefs: [],
    changes: [], verification: [], participants: [], artifacts: [], risks: [], corrections: [], references: [], ...overrides };
}

// Regression: a real child returned the old blocked protocol as its final model text.
// Only Host-owned outcome/lineage can classify the display; model JSON is not evidence.
test("completed blocked protocol becomes a disclosure without rewriting Host facts or source lineage", () => {
  const { input, step, outcome, raw, model } = fixture();
  const before = JSON.stringify(input);
  const [item] = projectWorkflowChildTimeline(input);
  assert.equal(item.kind, "protocolEvent");
  assert.equal(item.protocolKind, "workflow-step");
  assert.equal(item.status, "blocked");
  assert.deepEqual(item.blockedExplanation, { hostCode: outcome.code, hostReason: outcome.reason,
    agentReason: model.reason, rawJson: raw });
  assert.equal(item.id, "workflow-narration:step:run:event:event-1");
  assert.equal(item.revision, 8);
  assert.equal(item.sourceEventSequence, 1);
  assert.equal(item.itemId, "source");
  assert.equal(item.runId, "run");
  assert.equal(item.attemptId, "attempt");
  assert.equal(item.participantId, "qa");
  assert.equal(item.workflowStepId, step.id);
  for (const [kind, id] of [["conversation_item", "source"], ["run", "run"], ["attempt", "attempt"],
    ["participant", "qa"], ["workflow_step", "step"], ["run_event", "event-1"], ["run_event", "event-8"]]) {
    assert(item.sourceRefs.some(ref => ref.kind === kind && ref.id === id), `${kind}:${id}`);
  }
  assert.equal(item.actionId, undefined);
  assert.equal(item.markdown, undefined);
  assert.equal(JSON.stringify(input), before, "no durable outcomes, narration or actions are changed");
  assert.equal(hasWorkflowTimelineContent(item), true);
  assert.equal(hasWorkflowTimelineContent({ ...item, blockedExplanation: undefined }), false, "plan skeletons stay hidden");
});

test("blocked protocol is not final narration and cannot suppress the Host fallback or its copy", () => {
  const items = projectWorkflowChildTimeline(fixture().input);
  const presentation = projectTimelineResponsePresentation([...items, report()]);
  const response = presentation.responseByItemId.get("report");
  assert.equal(hasFinalTimelineResponseNarration(response), false);
  assert.equal(response.messages.length, 0);
  assert.equal(response.settled, true);
  const text = timelineResponseCopyText(response, false);
  assert.match(text, /HOST_FINAL_FALLBACK/u);
  assert.doesNotMatch(text, /AGENT_UNVERIFIED_REASON|"status"/u);
  const html = renderToStaticMarkup(React.createElement(ConversationTimelineTerminalReportRenderer,
    { item: report(), hasNarration: hasFinalTimelineResponseNarration(response), depth: 1 }));
  assert.match(html, /HOST_FINAL_FALLBACK/u);
  assert.equal(presentation.footerByItemId.size, 1);
});

test("plain JSON, examples, malformed, oversized and still-streaming responses keep their message semantics", () => {
  const { raw } = fixture();
  for (const content of ['{"status":"blocked"}', `Example:\n${raw}`, `\`\`\`json\n${raw}\n\`\`\``,
    raw.slice(0, -10), raw.replace('"network": false', '"network": "false"'),
    raw.replace('"status": "blocked"', '"status": "failed"'),
    raw.replace('"task": "synthetic-qa"', `"task": "${"x".repeat(33_000)}"`)]) {
    const { input, segment } = fixture(); segment.content = content;
    const [item] = projectWorkflowChildTimeline(input);
    assert.equal(item.kind, "agentMessage");
    assert.equal(item.markdown, content);
  }
  for (const status of ["running", "waiting_for_input", "waiting_for_approval", "succeeded", "failed", "cancelled"]) {
    const { input, step } = fixture(); step.status = status;
    assert.equal(projectWorkflowChildTimeline(input)[0].kind, "agentMessage", status);
  }
  const { input, segment } = fixture(); segment.completed = false;
  assert.equal(projectWorkflowChildTimeline(input)[0].kind, "agentMessage");
});

test("no conversion without a valid Host outcome and matching step, run, participant, attempt and source", () => {
  const variants = [
    ({ step }) => { delete step.metadata.delegatedOutcome; },
    ({ step }) => { step.metadata.delegatedOutcome = { kind: "blocked" }; },
    ({ outcome }) => { outcome.kind = "failed"; outcome.code = "delegated_run_failed"; },
    ({ outcome }) => { outcome.code = "delegated_run_missing"; },
    ({ outcome }) => { outcome.workflowId = "foreign"; outcome.lineage.workflowId = "foreign"; },
    ({ outcome }) => { outcome.workflowStepId = "foreign"; outcome.lineage.workflowStepId = "foreign"; },
    ({ outcome }) => { outcome.participantId = "foreign"; outcome.lineage.participantId = "foreign"; },
    ({ outcome }) => { outcome.lineage.runId = "foreign"; },
    ({ outcome }) => { outcome.lineage.attemptId = "foreign"; },
    ({ outcome }) => { outcome.lineage.runId = null; outcome.lineage.attemptId = null; },
    ({ outcome }) => { outcome.lineage.sourceRefs.pop(); },
    ({ outcome }) => { outcome.lineage.sourceRefs.push(outcome.lineage.sourceRefs[0]); },
    ({ outcome }) => { outcome.lineage.sourceRefs.push({ type: "run", id: "foreign" }); },
    ({ outcome }) => { outcome.lineage.sourceRefs.push({ type: "conversation_item", id: "foreign" }); },
    ({ input }) => { input.parentItemId = "foreign"; },
    ({ step }) => { step.metadata.sourceMessageId = "foreign"; },
    ({ input, step }) => { delete input.parentItemId; delete step.metadata.sourceMessageId; },
    ({ step }) => { delete step.runNarration.attemptId; },
    ({ step }) => { step.runNarration.sourceItemId = "foreign"; },
    ({ step }) => { step.runNarration.runId = "foreign"; },
    ({ step }) => { step.runNarration.participantId = "foreign"; },
    ({ step }) => { step.runNarration.workflowStepId = "foreign"; },
  ];
  for (const [index, change] of variants.entries()) {
    const data = fixture(); change(data);
    assert(!projectWorkflowChildTimeline(data.input).some(item => item.blockedExplanation), `variant ${index}`);
  }
  for (const field of ["workspaceId", "threadId", "turnId", "runId", "participantId", "attemptId"]) {
    const data = fixture();
    data.segment.source = { workspaceId: "workspace", threadId: "parent-thread", turnId: "turn", runId: "run",
      participantId: "qa", attemptId: "attempt", workUnitId: "unit", [field]: "foreign" };
    assert(!projectWorkflowChildTimeline(data.input).some(item => item.blockedExplanation), field);
  }
});

test("only the completed last segment folds; commentary and separate Agent scopes remain independent", () => {
  const { input, step, segment } = fixture();
  step.runNarration.segments = [{ ...segment, firstEventId: "commentary", lastEventId: "commentary",
    startEventSequence: 0, endEventSequence: 0 }, segment];
  const items = projectWorkflowChildTimeline(input);
  assert.deepEqual(items.map(item => item.kind), ["agentMessage", "protocolEvent"]);
  assert.equal(items[0].phase, "commentary");
  const parent = { id: "parent-final", kind: "agentMessage", turnId: "parent-turn", runId: "parent-run",
    phase: "final", status: "succeeded", markdown: "PARENT_FINAL", sourceRefs: [] };
  const child = { id: "child", kind: "subAgentActivity", turnId: "parent-turn", runId: "parent-run", status: "blocked",
    lifecycle: "blocked", childItems: [...items, report()], sourceRefs: [] };
  const presentation = projectTimelineResponsePresentation([parent, child]);
  const response = presentation.responseByItemId.get("report");
  assert.equal(hasFinalTimelineResponseNarration(response), false);
  assert.doesNotMatch(timelineResponseCopyText(response, false), /PARENT_FINAL/u);
  assert.match(timelineResponseCopyText(response, false), /HOST_FINAL_FALLBACK/u);
});

test("blocked explanation uses an initially closed fact disclosure, never a bare JSON final answer", () => {
  const [item] = projectWorkflowChildTimeline(fixture().input);
  const html = renderToStaticMarkup(React.createElement(ConversationTimelineProtocolRenderer, { item, depth: 1 }));
  assert.match(html, /aria-expanded="false"/u);
  assert.match(html, /Task blocked/u);
  assert.match(html, /Insufficient evidence/u);
  assert.doesNotMatch(html, /AGENT_UNVERIFIED_REASON|HOST_REASON|"proposal"/u);
});

test("expanded explanation marks model claims unverified, renders paths literally and copies the entire original JSON", async t => {
  const renderer = "shared/conversation/timeline/ConversationTimelineProtocolRenderer.tsx";
  const harness = await catalogConsumerHarness(t, {
    exports: { [renderer]: ["ConversationTimelineProtocolRenderer", "BlockedExplanationDetail"] },
    expose: { [renderer]: ["BlockedExplanationDetail"] },
    transforms: { "shared/conversation/feedback/CopyActionButton.tsx": [{
      anchor: "  return <SharedCopyActionButton {...props}",
      replace: key => `  globalThis[${JSON.stringify(key)}].captures.copyText = props.text;\n  return <SharedCopyActionButton {...props}`,
    }] },
  });
  const { raw, outcome } = fixture();
  const [item] = projectWorkflowChildTimeline(fixture().input);
  const html = harness.render(harness.module.BlockedExplanationDetail, { explanation: item.blockedExplanation });
  assert.ok(html.includes(outcome.reason));
  assert.match(html, /required_operation_evidence_missing/u);
  assert.ok(html.includes(harness.state.t("terminal_report.meta.unverified")));
  assert.match(html, /AGENT_UNVERIFIED_REASON/u);
  assert.match(html, /\*\*not Markdown\*\*/u);
  assert.match(html, /\/synthetic\/input\.cjs/u);
  assert.doesNotMatch(html, /<a\b|message-file-link|local-file-link/u);
  assert.match(html, /data-language="json"/u);
  assert.match(html, /message-code-copy/u);
  assert.equal(harness.state.captures.copyText, raw, "the real CodeBlock copy port receives raw text including all hidden lines and whitespace");
  assert(raw.split("\n").length > 24, "fixture exercises CodeBlock's ordinary line collapse");
});

test("the complete workflow adapter keeps the child explanation visible without fabricating operation evidence", () => {
  const { step } = fixture();
  const progress = buildWorkflowProgressModel({ workflow: { id: "workflow", workspaceId: "workspace", channelId: "channel",
    title: "Synthetic QA", objective: "Validate", status: "blocked", metadata: { sourceMessageId: "source" },
    createdAt: "time", updatedAt: "time" }, steps: [step], runs: [], approvals: [], artifactsByRun: {}, t: key => key });
  const timeline = conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress));
  const child = timeline.find(item => item.kind === "subAgentActivity");
  assert(child, "protocol-only child is not removed as an empty plan skeleton");
  assert.equal(child.status, "blocked");
  assert.equal(child.childItems[0].kind, "protocolEvent");
  assert.equal(child.childItems[0].blockedExplanation.hostCode, "required_operation_evidence_missing");
  assert(child.childItems.every(item => !item.actionId));
  assert(progress.agentSpans[0].rows.every(row => !row.operationExecution));
});

test("well-formed but foreign Host outcomes do not borrow this child's explanation", () => {
  for (const [field, refType] of [["workflowId", "workflow"], ["workflowStepId", "workflow_step"],
    ["runId", "run"], ["attemptId", "attempt"], ["participantId", undefined]]) {
    const { input, outcome } = fixture();
    if (field in outcome) outcome[field] = "foreign";
    outcome.lineage[field] = "foreign";
    if (refType) outcome.lineage.sourceRefs = outcome.lineage.sourceRefs.map(ref => ref.type === refType ? { ...ref, id: "foreign" } : ref);
    assert.equal(isDelegatedOutcomeV1(outcome), true, field);
    assert.equal(projectWorkflowChildTimeline(input)[0].kind, "agentMessage", field);
  }
});

test("shape parsing is bounded, complete and unverified rather than a generic JSON detector", () => {
  const { parseUnverifiedBlockedNarration } = conversationUiCore;
  const { model, raw } = fixture();
  assert.deepEqual(parseUnverifiedBlockedNarration(raw), { rawJson: raw, agentReason: model.reason });
  const changes = [
    value => { value.extra = "not the protocol"; },
    value => { delete value.decision; },
    value => { value.reason = " "; },
    value => { value.task = 42; },
    value => { value.missingCapabilities = []; },
    value => { value.missingCapabilities = [42]; },
    value => { value.proposal = null; },
    value => { value.proposal.command = ""; },
    value => { value.proposal.readPaths = "file"; },
    value => { value.proposal.writePaths = [false]; },
    value => { value.proposal.network = "false"; },
    value => { value.verification = []; },
    value => { value.verification.entryFileRead = null; },
    value => { value.verification.commandExecuted = 0; },
    value => { value.verification.toolsCalled = "false"; },
    value => { value.verification.dependencyRequirement = ""; },
  ];
  for (const [index, change] of changes.entries()) {
    const value = structuredClone(model); change(value);
    assert.equal(parseUnverifiedBlockedNarration(JSON.stringify(value)), undefined, `shape ${index}`);
  }
  for (const text of ["null", "[]", "true", '"blocked"', `Before ${raw}`, `${raw} after`, " ".repeat(32_769), raw.slice(0, -10)]) {
    assert.equal(parseUnverifiedBlockedNarration(text), undefined);
  }
});

test("a fully owned segment and either existing canonical source anchor can support the disclosure", () => {
  for (const omitted of [undefined, "parentItemId", "sourceMessageId"]) {
    const { input, step, segment } = fixture();
    if (omitted === "parentItemId") delete input.parentItemId;
    if (omitted === "sourceMessageId") delete step.metadata.sourceMessageId;
    segment.source = { workspaceId: "workspace", threadId: "parent-thread", turnId: "turn", runId: "run",
      attemptId: "attempt", participantId: "qa", workUnitId: "unit" };
    const [item] = projectWorkflowChildTimeline(input);
    assert.equal(item.kind, "protocolEvent");
    assert.equal(item.workUnitId, "unit");
  }
  const { input, segment } = fixture();
  segment.source = { workspaceId: "workspace", threadId: "parent-thread", turnId: "turn", runId: "run",
    attemptId: "attempt", participantId: "qa", workUnitId: "" };
  assert.equal(projectWorkflowChildTimeline(input)[0].kind, "agentMessage");
});

test("the operation prompt retains exact command and ownership limits but separates narration from Host outcome", () => {
  const source = readFileSync(new URL("../../../packages/daemon/src/features/channels/proposal-workflows.ts", import.meta.url), "utf8");
  const match = source.match(/const rule = ("[^\n]+");/u);
  assert(match, "find the actual owned-operation prompt");
  const rule = JSON.parse(match[1]);
  assert.ok(rule.startsWith("Execute only the operations owned by this step. An exact command must be run exactly; do not substitute a semantically equivalent command."));
  assert.match(rule, /what was not executed or verified/u);
  assert.match(rule, /do not return ready text or a raw blocked JSON/u);
  assert.match(rule, /Host records the structured blocked outcome from verified tool and execution evidence/u);
  assert.doesNotMatch(rule, /return structured blocked instead of ready text or narration/u);
});
