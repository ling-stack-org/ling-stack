import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(0, -3)}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildWorkflowProgressModel,
  workflowProgressToConversationWorkCell,
} = await import("../src/lib/workflow-progress.ts");
const { conversationTimelineItemsForModel } = await import("../src/lib/conversation-work-cell.ts");

const t = (key) => key;

function workflow(id) {
  return {
    id,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    title: `${id} workflow`,
    objective: "Complete the task",
    status: "succeeded",
    createdBy: "local-user",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:01:00.000Z",
  };
}

function step(workflowId, id, position, participantId, label) {
  return {
    id,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    workflowId,
    position,
    title: `${label}: complete task`,
    prompt: `Complete task as ${label}`,
    toParticipantId: participantId,
    toParticipantLabel: label,
    participantAuthority: "workflow_member",
    status: "succeeded",
    resultSummary: `${label} completed`,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:01:00.000Z",
  };
}

function timelineFor(workflowId, stepId) {
  const taskStep = {
    ...step(workflowId, stepId, 0, "teammate_builtin_engineer", "Engineer"),
    runId: `run-${workflowId}`,
    runNarration: {
      runId: `run-${workflowId}`,
      participantId: "teammate_builtin_engineer",
      workflowStepId: stepId,
      threadId: "thread-parent",
      turnId: `turn-${workflowId}`,
      sourceItemId: `source-${workflowId}`,
      sourceItemSequence: 1,
      attemptId: `attempt-${workflowId}`,
      segments: [{
        content: "Completed with evidence.",
        firstEventId: `event-${workflowId}`,
        lastEventId: `event-${workflowId}`,
        startEventSequence: 1,
        endEventSequence: 1,
        completed: true,
      }],
    },
  };
  const progress = buildWorkflowProgressModel({
    workflow: workflow(workflowId),
    steps: [taskStep],
    runs: [],
    approvals: [],
    artifactsByRun: {},
    t,
  });
  return conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress));
}

test("workflow participant timeline identity is scoped per workflow", () => {
  const first = timelineFor("workflow-first", "step-first");
  const second = timelineFor("workflow-second", "step-second");
  const nestedFirst = first.filter((item) => item.kind === "subAgentActivity");
  const nestedSecond = second.filter((item) => item.kind === "subAgentActivity");

  assert.equal(nestedFirst.length, 1);
  assert.equal(nestedSecond.length, 1);
  assert.notEqual(nestedFirst[0].id, nestedSecond[0].id);
  assert.match(nestedFirst[0].id, /workflow-first/);
  assert.match(nestedSecond[0].id, /workflow-second/);
});

test("workflow-only participant steps do not fabricate sub Agent evidence", () => {
  const progress = buildWorkflowProgressModel({
    workflow: workflow("workflow-plan-only"),
    steps: [step("workflow-plan-only", "step-plan-only", 0, "teammate_builtin_engineer", "Engineer")],
    runs: [],
    approvals: [],
    artifactsByRun: {},
    t,
  });

  assert.equal(progress.agentSpans.length, 0);
  assert.equal(
    conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress))
      .filter((item) => item.kind === "subAgentActivity").length,
    0,
  );
});

function narratedTimeline({ runId = 'run-1', participantId = 'teammate_builtin_engineer', status = 'succeeded', revision = 37, sourceEventSequence = 36 } = {}) {
  const sourceRefs = [{ kind: 'conversation_item', id: 'source-1' }, { kind: 'run', id: 'run-1' }];
  const taskStep = { ...step('workflow-1', 'step-1', 0, 'teammate_builtin_engineer', 'Engineer'), runId: 'run-1', status,
    resultSummary: 'Inspect first.\n\n## Result\nAll checked.',
    runNarration: { runId, participantId, workflowStepId: 'step-1', threadId: 'thread-parent', turnId: 'turn-1', sourceItemId: 'source-1', sourceItemSequence: 7, attemptId: 'attempt-1',
      segments: [
        { content: 'Inspect first.', firstEventId: 'event-1', lastEventId: 'event-35', startEventSequence: 1, endEventSequence: 35, completed: true },
        { content: '## Result\nAll checked.', firstEventId: 'event-38', lastEventId: 'event-40', startEventSequence: 38, endEventSequence: 40, completed: status === 'succeeded' },
      ] },
  };
  const action = { id: 'read-1', revision, sourceEventSequence, workspaceId: 'workspace-1', runId: 'run-1', attemptId: 'attempt-1', participantId: 'teammate_builtin_engineer', workflowStepId: 'step-1',
    actionType: 'read', risk: 'low', status: 'succeeded', title: 'Read file', summary: 'Read file', targetRefs: [{ type: 'file', path: 'test.ts' }], previewArtifactIds: [], resultArtifactIds: [], sourceRefs,
    createdAt: '2026-09-06T00:00:00Z', toolEvidence: { toolName: 'read', inputSummary: 'test.ts', outputText: 'const x = 1;', outputTruncated: false, latestEventSeq: revision } };
  const progress = buildWorkflowProgressModel({ workflow: { ...workflow('workflow-1'), status }, steps: [taskStep],
    runs: [], approvals: [], artifactsByRun: {}, executionActions: [action], t });
  return conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress)).find(item => item.kind === 'subAgentActivity').childItems;
}

test('workflow child interleaves narration with its actual read sequence and source lineage', () => {
  const rows = narratedTimeline();
  assert.deepEqual(rows.map(row => row.kind), ['agentMessage', 'exploration', 'agentMessage']);
  assert.deepEqual(rows.map(row => row.sourceEventSequence), [1, 36, 38]);
  assert.deepEqual(rows.filter(row => row.kind === 'agentMessage').map(row => row.markdown), ['Inspect first.', '## Result\nAll checked.']);
  for (const row of rows) {
    assert.equal(row.runId, 'run-1');
    assert.equal(row.attemptId, 'attempt-1');
    assert.equal(row.participantId, 'teammate_builtin_engineer');
    assert.equal(row.workflowStepId, 'step-1');
    assert(row.sourceRefs.some(ref => ref.kind === 'conversation_item' && ref.id === 'source-1'));
  }
});

test('workflow child tool updates do not move the read behind the final narrative', () => {
  const before = narratedTimeline();
  const after = narratedTimeline({ revision: 999 });
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.deepEqual(after.map(row => row.sourceEventSequence), [1, 36, 38]);
});

test('workflow child keeps streaming narrative commentary rather than a final result', () => {
  const rows = narratedTimeline({ status: 'running' }).filter(row => row.kind === 'agentMessage');
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.phase === 'commentary'));
});

for (const foreign of [{ runId: 'run-other' }, { participantId: 'teammate_builtin_qa' }]) {
  test(`workflow child rejects foreign narrative ownership ${JSON.stringify(foreign)}`, () => {
    assert.equal(narratedTimeline(foreign).filter(row => row.kind === 'agentMessage').length, 0);
  });
}

test('narration refresh rejects late retry and lower-revision responses', async () => {
  const { mergeWorkflowNarration, liveNarrationWorkflowIds } = await import('../src/lib/workflow-narration-refresh.ts');
  const current = [{ ...step('workflow-1', 'step-1', 0, 'engineer', 'Engineer'), runId: 'run-2', runNarration: { segments: [{ endEventSequence: 9 }] } }];
  assert.equal(mergeWorkflowNarration(current, [{ ...current[0], runId: 'run-1', runNarration: { segments: [{ endEventSequence: 999 }] } }]), current);
  assert.equal(mergeWorkflowNarration(current, [{ ...current[0], runNarration: { segments: [{ endEventSequence: 8 }] } }]), current);
  assert.equal(mergeWorkflowNarration(current, [{ ...current[0], runNarration: { segments: [{ endEventSequence: 10 }] } }])[0].runNarration.segments[0].endEventSequence, 10);
  assert.deepEqual(liveNarrationWorkflowIds(current, [{ id: 'run-2', channelId: 'channel-1', status: 'running' }], 'channel-1'), ['workflow-1']);
  assert.deepEqual(liveNarrationWorkflowIds(current, [{ id: 'run-2', channelId: 'channel-1', status: 'succeeded' }], 'channel-1'), []);
});

test('narration refresh clears revoked text without accepting another scope or step lifecycle', async () => {
  const { mergeWorkflowNarration } = await import('../src/lib/workflow-narration-refresh.ts');
  const current = [{ ...step('workflow-1', 'step-1', 0, 'engineer', 'Engineer'), status: 'running', runId: 'run-1',
    runNarration: { segments: [{ endEventSequence: 9 }] } }];
  for (const field of ['id', 'workspaceId', 'channelId', 'workflowId', 'runId', 'toParticipantId']) {
    assert.equal(mergeWorkflowNarration(current, [{ ...current[0], [field]: 'foreign', runNarration: null }]), current, field);
  }
  assert.equal(mergeWorkflowNarration(current, [{ ...current[0], runNarration: undefined }]), current);
  const revoked = mergeWorkflowNarration(current, [{ ...current[0], status: 'succeeded', runNarration: null }]);
  assert.equal(revoked[0].runNarration, null);
  assert.equal(revoked[0].status, 'running');
  assert.equal(mergeWorkflowNarration(revoked, [{ ...revoked[0] }]), revoked);
  const restored = mergeWorkflowNarration(revoked, current);
  assert.deepEqual(restored[0].runNarration, current[0].runNarration);
});
