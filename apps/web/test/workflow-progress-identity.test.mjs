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
const { buildCollaborationTaskCardModel } = await import("../src/lib/collaboration-task-card.ts");
const { collaborationTaskCardToConversationWorkCell } = await import("../src/lib/collaboration-task-work-cell.ts");

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

function narratedTimeline({ runId = 'run-1', participantId = 'teammate_builtin_engineer', status = 'succeeded', revision = 37, sourceEventSequence = 36, parent = false } = {}) {
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
  const item = conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress)).find(item => item.kind === 'subAgentActivity');
  return parent ? item : item.childItems;
}

test('workflow participant status preserves blocked, cancellation, queued and distinct waits', () => {
  for (const [status, lifecycle, projectedStatus, stateLabel] of [
    ['blocked', 'blocked', 'blocked', 'Blocked'], ['cancelled', 'interrupted', 'cancelled', 'Stopped'],
    ['failed', 'errored', 'failed', 'Failed'], ['queued', 'started', 'pending', undefined],
    ['running', 'running', 'running', undefined], ['claimed', 'running', 'running', undefined],
    ['succeeded', 'completed', 'succeeded', undefined], ['skipped', 'completed', 'succeeded', undefined],
    ['waiting_for_approval', 'waiting', 'waiting', 'Waiting for approval'],
    ['waiting_for_input', 'waiting', 'waiting', 'waiting for user input'],
  ]) {
    const item = narratedTimeline({ status, parent: true });
    assert.equal(item.lifecycle, lifecycle, status);
    assert.equal(item.status, projectedStatus, status);
    assert.equal(item.stateLabel, stateLabel, status);
  }
});

test('collaboration adapter preserves blocked, cancelled, queued and distinct wait semantics', () => {
  for (const [status, lifecycle, stateLabel] of [
    ['blocked', 'blocked', 'Blocked'], ['cancelled', 'interrupted', 'Stopped'],
    ['queued', 'started', undefined], ['waiting_for_approval', 'waiting', 'Waiting for approval'],
    ['waiting_for_input', 'waiting', 'waiting for user input'],
  ]) {
    const input = { workflow: { ...workflow('collab-state'), status },
      steps: [{ ...step('collab-state', 'collab-step', 0, 'teammate_builtin_engineer', 'Engineer'),
        status, resultSummary: 'Inspect owned input before executing the CLI.' }], runs: [], approvals: [], t };
    const card = buildCollaborationTaskCardModel(input);
    const progress = buildWorkflowProgressModel({ ...input, artifactsByRun: {} });
    const model = collaborationTaskCardToConversationWorkCell({ card, progress, t });
    const item = conversationTimelineItemsForModel(model).find(row => row.kind === 'subAgentActivity');
    assert.equal(item.lifecycle, lifecycle, status);
    assert.equal(item.stateLabel, stateLabel, status);
    if (status === 'waiting_for_input') {
      assert.equal(card.mode, 'waiting');
      assert.equal(card.steps[0].state, 'waiting');
    }
  }
});

for (const parallel of [false, true]) {
  for (const [statuses, lifecycle, stateLabel] of [
    [['queued', 'waiting_for_input'], 'waiting', 'waiting for user input'],
    [['succeeded', 'cancelled'], 'interrupted', 'Stopped'],
    [['cancelled', 'succeeded'], 'interrupted', 'Stopped'],
  ]) {
    test(`participant aggregate does not fabricate approval: ${statuses.join('+')}, parallel=${parallel}`, () => {
      const input = { workflow: { ...workflow('aggregate-state'), status: 'running' },
        steps: statuses.map((status, index) => ({ ...step('aggregate-state', `aggregate-${index}`, index,
          'teammate_builtin_engineer', 'Engineer'), status, resultSummary: 'Inspect the owned command result.',
          runId: `aggregate-run-${index}`, runNarration: {
            runId: `aggregate-run-${index}`, participantId: 'teammate_builtin_engineer', workflowStepId: `aggregate-${index}`,
            threadId: 'parent-thread', turnId: 'parent-turn', sourceItemId: 'parent-item', sourceItemSequence: 1,
            segments: [{ content: 'Inspect the owned command result.', firstEventId: `narrative-${index}`,
              lastEventId: `narrative-${index}`, startEventSequence: 1, endEventSequence: 1, completed: true }],
          },
          ...(parallel ? { metadata: { branchGroupId: 'owned-branch' } } : {}) })), runs: [], approvals: [], t };
      const progress = buildWorkflowProgressModel({ ...input, artifactsByRun: {} });
      const workflowItem = conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress))
        .find(row => row.kind === 'subAgentActivity');
      assert.equal(workflowItem.lifecycle, lifecycle);
      const card = buildCollaborationTaskCardModel(input);
      const model = collaborationTaskCardToConversationWorkCell({ card, progress, t });
      const item = conversationTimelineItemsForModel(model).find(row => row.kind === 'subAgentActivity');
      assert.equal(item.lifecycle, lifecycle);
      assert.equal(item.stateLabel, stateLabel);
    });
  }
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
