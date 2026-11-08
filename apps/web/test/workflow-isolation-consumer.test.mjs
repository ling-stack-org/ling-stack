import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "../scripts/typescript-ast.mjs";
import { catalogConsumerHarness } from "./support/catalog-consumer-harness.mjs";
import { catalogHookPort } from "./support/catalog-hook-port.mjs";
import { evidence, hookTransforms, round, steps, workflow } from "./support/workflow-isolation-evidence-fixture.mjs";

const { buildWorkflowProgressModel, workflowProgressToConversationWorkCell } = await import("../src/lib/workflow-progress.ts");
const { enUS } = await import("../src/i18n/locales/en-US.ts");
const { zhCN } = await import("../src/i18n/locales/zh-CN.ts");
const sourcePath = fileURLToPath(new URL("../src/features/workspace/WorkspaceClientView.tsx", import.meta.url));
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
// Execute the real consumer declarations, not an alternate adapter or the unused details builder.
const declarations = withTypeScriptSourceFiles([sourcePath], files => {
  const source = files.get(sourcePath), selected = new Map();
  visitTypeScriptNode(source, node => {
    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
      const name = declaration.name.getText(source);
      if (["workflowIsolationEvidenceByWorkflowId", "workflowProgressByWorkflowId", "conversationWorkCellByWorkflowId"].includes(name)) {
        assert.equal(selected.has(name), false);
        selected.set(name, node.getText(source));
      }
    }
  });
  assert.equal(selected.size, 3);
  return [...selected.values()].map(text => stripTypeScriptTypes(text, { mode: "transform" })).join("\n");
}, { cwd: sourceRoot });

async function fixture(t, payload = evidence()) {
  const port = catalogHookPort(), requests = [], captures = [];
  const ports = { hooks: port.hooks,
    observation: { paused: false, epoch: 0, workspaceCwd: "/qa", baseUrl: "http://127.0.0.1:9999" },
    request: async (...args) => { requests.push(args); return { workflow: workflow(), isolation: payload }; },
    mountTimeline: input => { captures.push(input); return { node: null }; },
  };
  const h = await catalogConsumerHarness(t, { ports,
    exports: {
      "features/workspace/useWorkflowIsolationEvidence.ts": ["useWorkflowIsolationEvidence"],
      "features/workspace/ChannelMessageRenderers.tsx": ["createChannelMessageRenderers"],
      "shared/conversation/timeline/ConversationTimelineProtocolRenderer.tsx": ["ConversationTimelineProtocolRenderer"],
    }, transforms: { ...hookTransforms, "features/workspace/ChannelMessageRenderers.tsx": [
      { anchor: "return mountConversationRunFeedbackTimeline({", replace: key => `return globalThis[${JSON.stringify(key)}].ports.mountTimeline({` },
    ] },
  });
  h.state.messages = enUS;
  const runActualWorkspaceChain = runInNewContext(`(function(input) {
    const {cwd, selectedChannelId, daemonHealthy, selectedChannelWorkflows, selectedChannelWorkflowSteps,
      channelCollaborationCardRefreshSignature, committedTerminalReportItemRevisionSignature, channelConversationRefreshToken,
      channelWorkflowsForDisplay, channelWorkflowStepsForDisplay, channelRuns, approvals, channelArtifactsByRunForDisplay,
      channelExecutionActionsForDisplay, channelContextSegmentIdByItemId, t, terminalReportByWorkflowId} = input;
    ${declarations}
    return { workflowProgressByWorkflowId, conversationWorkCellByWorkflowId };
  })`, { useMemo: port.hooks.useMemo, useWorkflowIsolationEvidence: h.module.useWorkflowIsolationEvidence,
    buildWorkflowProgressModel, workflowProgressToConversationWorkCell, artifactContentUrl: id => `qa-artifact:${id}` });
  const owner = workflow(), tasks = steps(owner);
  const input = { cwd: "/qa", selectedChannelId: owner.channelId, daemonHealthy: true, selectedChannelWorkflows: [owner], selectedChannelWorkflowSteps: tasks,
    channelCollaborationCardRefreshSignature: "initial", committedTerminalReportItemRevisionSignature: "", channelConversationRefreshToken: 0,
    channelWorkflowsForDisplay: [owner], channelWorkflowStepsForDisplay: tasks, channelRuns: [], approvals: [], channelArtifactsByRunForDisplay: {},
    channelExecutionActionsForDisplay: [], channelContextSegmentIdByItemId: new Map(), t: h.state.t, terminalReportByWorkflowId: new Map() };
  t.after(() => port.unmount());
  function snapshot(chain) {
    const renderers = h.module.createChannelMessageRenderers({
      cwd: input.cwd, workspaceId: owner.workspaceId, selectedChannelId: owner.channelId, selectedChannelThreadId: "thread-qa",
      selectedChannelBranchRootThreadId: undefined, allLocalTeammateById: new Map(), composerGateApprovals: [],
      channelConversationItems: [], channelReasoningSummaries: [], channelContextCompactions: [], channelUserInputs: [],
      channelWorkflows: [owner], terminalReports: [], workflowErrors: {}, auditActivityVisible: false,
      conversationWorkCellByThreadId: new Map(), runLifecycles: [], contextSegmentIdByItemId: new Map(),
      workflowProgressByWorkflowId: chain.workflowProgressByWorkflowId,
      conversationWorkCellByWorkflowId: chain.conversationWorkCellByWorkflowId, t: h.state.t,
    });
    renderers.renderUnifiedTimeline([{ kind: "activity", item: { id: `workflow:${owner.id}`, kind: "workflow", record: owner,
      createdAt: owner.updatedAt, category: "runtime", attention: "none", searchText: "" } }]);
    return captures.at(-1).snapshot;
  }
  return { ...h, port, input, requests, ports, snapshot,
    mounted: () => captures.at(-1),
    chain: () => port.render(runActualWorkspaceChain, input),
    setPayload: next => { payload = next; },
  };
}

test("actual Workspace API→progress→work-cell→Channel renderer keeps one approval entry with both real participant spans", async t => {
  const f = await fixture(t);
  f.chain(); await f.port.flush();
  const chain = f.chain();
  assert.deepEqual(f.requests, [["/qa", "workflow-qa"]]);
  const progress = chain.workflowProgressByWorkflowId.get("workflow-qa");
  assert.equal(progress.mode, "active", "a succeeded step lifecycle is not a completed target delivery");
  assert.equal(progress.summary, "Awaiting merge approval");
  const items = f.snapshot(chain).items;
  assert.equal(items.some(item => item.id === "workflow-isolation:workflow-qa:observation"), false);
  const roundFact = items.find(item => item.id === "workflow-isolation:workflow-qa:round:round-qa:1");
  assert.equal(roundFact.title, "Awaiting merge approval");
  assert.equal(roundFact.meta, undefined);
  assert.equal(roundFact.description, undefined);
  const participants = items.filter(item => item.kind === "subAgentActivity");
  assert.equal(participants.length, 2);
  for (const [index, participant] of participants.entries()) {
    assert(participant.childItems.some(item => item.kind === "agentMessage" && item.markdown === `Participant ${index + 1} recorded result`));
  }
  const html = f.render(f.module.ConversationTimelineProtocolRenderer, { item: roundFact, depth: 0 });
  assert.doesNotMatch(html, /Integration round 1|Candidate commit|Candidate tree|generation/u);
  assert.match(html, /Awaiting merge approval/u);
  assert.match(html, /data-conversation-timeline-status="waiting"/u);
  assert.doesNotMatch(html, /data-conversation-action-id=/u);
});

test("actual reload/SSE consumer converges approved-not-applied→applying→applied without changing ordinary work-cell authority", async t => {
  const f = await fixture(t, evidence({ rounds: [round({ approval: { approvalId: "approval-qa", status: "approved" } })] }));
  f.chain(); await f.port.flush();
  assert.equal(f.chain().workflowProgressByWorkflowId.get("workflow-qa").summary, "Merge approved; not yet applied");
  f.setPayload(evidence({ rounds: [round({ phase: "applying", application: { status: "pending" } })] }));
  f.input.channelConversationRefreshToken++; f.chain(); await f.port.flush();
  assert.equal(f.chain().workflowProgressByWorkflowId.get("workflow-qa").summary, "Applying candidate to target");
  f.setPayload(evidence({ completion: "ready", rounds: [round({ phase: "applied", application: { status: "applied" } })] }));
  f.input.channelCollaborationCardRefreshSignature = "terminal-item-reloaded"; f.chain(); await f.port.flush();
  const chain = f.chain();
  assert.equal(chain.workflowProgressByWorkflowId.get("workflow-qa").mode, "completed");
  assert.equal(chain.workflowProgressByWorkflowId.get("workflow-qa").summary, "Applied to target");
  assert.equal(f.requests.length, 3);
  const snapshot = f.snapshot(chain);
  const integrationItems = snapshot.items.filter(item => item.id.startsWith("workflow-isolation:"));
  assert.equal(integrationItems.length, 1);
  assert.equal(integrationItems[0].meta, undefined);
  assert.equal(integrationItems[0].title, "Applied to target");
  assert.deepEqual(integrationItems[0].availableActions, []);
  const owner = snapshot.items.find(item => item.protocolKind === "workflow");
  const graph = f.mounted().renderProtocolDetail(owner);
  assert(graph.props.timelineItems.some(item => item.id.startsWith("workflow-isolation:") && item.meta === "Applied to target"),
    "settled integration facts remain in the graph inputs without duplicate conversation rows");
});

test("the real consumer does not hide retained integration evidence when the current step list is empty", async t => {
  const f = await fixture(t);
  f.input.selectedChannelWorkflowSteps = []; f.input.channelWorkflowStepsForDisplay = [];
  f.chain(); await f.port.flush();
  const chain = f.chain();
  assert(chain.conversationWorkCellByWorkflowId.has("workflow-qa"));
  assert(f.snapshot(chain).items.some(item => item.id.startsWith("workflow-isolation:")));
});

test("existing protocol component renders unconfirmed cancelled observations separately, including Chinese source catalog", async t => {
  const f = await fixture(t, evidence({ hostOperationPending: true }));
  f.state.locale = "zh-CN"; f.state.messages = zhCN;
  f.input.channelWorkflowsForDisplay = [workflow({ status: "cancelled" })];
  f.chain(); await f.port.flush();
  const chain = f.chain(), observation = f.snapshot(chain).items.find(item => item.id.endsWith(":observation"));
  const html = f.render(f.module.ConversationTimelineProtocolRenderer, { item: observation, depth: 0 });
  assert.match(html, /工作流已取消/u);
  assert.match(html, /集成结果待确认/u);
  assert.doesNotMatch(html, /Host 操作仍在收尾|Integration round|Candidate commit/u);
  assert.match(html, /data-conversation-timeline-status="cancelled"/u);
  assert.doesNotMatch(html, /已应用到目标|Succeeded/u);
});

test("consumer wiring listens to existing refresh signature/SSE inputs and does not introduce a page, graph or feature flag", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(declarations, /channelCollaborationCardRefreshSignature/u);
  assert.match(declarations, /committedTerminalReportItemRevisionSignature/u);
  assert.match(declarations, /channelConversationRefreshToken/u);
  assert.match(declarations, /isolationEvidence/u);
  assert.equal(source.includes("buildConversationWorkCellDetailsFromWorkflowEvidence("), false);
});
