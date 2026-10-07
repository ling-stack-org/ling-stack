import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkflowStepNarration } from '../dist/features/channels/workflow-step-narration.js';

const step = { id: 'step-1', workspaceId: 'workspace-1', channelId: 'channel-1', workflowId: 'workflow-1', runId: 'run-1', toParticipantId: 'engineer' };
const run = { id: 'run-1', workflowStepId: 'step-1', teammateId: 'engineer', channelId: 'channel-1' };
const source = { id: 'source-1', workspaceId: 'workspace-1', channelId: 'channel-1', threadId: 'thread-1', turnId: 'turn-1', sequence: 7, visibility: 'channel', kind: 'user_message', status: 'committed' };
const workflow = { id: 'workflow-1', workspaceId: 'workspace-1', channelId: 'channel-1', metadata: { sourceMessageId: 'source-1', sourceTurnId: 'turn-1' } };
const event = (seq, type, data) => ({ id: `event-${seq}`, runId: 'run-1', seq, ts: '2026-09-06T00:00:00Z', type, data });
const events = [event(1, 'run_created', { attemptId: 'attempt-1' }), event(2, 'message_end', { role: 'assistant', text: 'Inspect first.' }), event(3, 'tool_start', { toolName: 'read' }), event(4, 'tool_end', { toolName: 'read' }), event(1001, 'message_end', { role: 'assistant', text: '## Result\nChecked.' })];
function store(overrides = {}) {
  return { readSnapshot: read => read(), getChannelWorkflowStep: () => step,
    getRun: () => run, getChannelWorkflow: () => workflow, getConversationItem: () => source,
    listEvents: (_id, { afterSeq, limit }) => events.filter(entry => entry.seq > afterSeq).slice(0, Math.min(limit, 2)), ...overrides };
}

test('workflow narration replays paged events with exact parent source and attempt ownership', () => {
  const before = JSON.stringify(step);
  const result = projectWorkflowStepNarration(store(), step).runNarration;
  assert.equal(JSON.stringify(step), before);
  assert.equal(result.sourceItemId, source.id);
  assert.equal(result.turnId, source.turnId);
  assert.equal(result.attemptId, 'attempt-1');
  assert.deepEqual(result.segments.map(segment => [segment.firstEventId, segment.startEventSequence, segment.content]), [
    ['event-2', 2, 'Inspect first.'], ['event-1001', 1001, '## Result\nChecked.'],
  ]);
});

for (const [name, overrides] of [
  ['missing run', { getRun: () => undefined }],
  ['foreign step', { getRun: () => ({ ...run, workflowStepId: 'step-other' }) }],
  ['foreign participant', { getRun: () => ({ ...run, teammateId: 'qa' }) }],
  ['foreign channel', { getRun: () => ({ ...run, channelId: 'channel-other' }) }],
  ['foreign workspace', { getConversationItem: () => ({ ...source, workspaceId: 'workspace-other' }) }],
  ['private source', { getConversationItem: () => ({ ...source, visibility: 'agent_private' }) }],
  ['pending source', { getConversationItem: () => ({ ...source, status: 'pending' }) }],
  ['foreign turn', { getConversationItem: () => ({ ...source, turnId: 'turn-other' }) }],
]) test(`workflow narration rejects ${name} before reading any events`, () => {
  assert.equal(projectWorkflowStepNarration(store({ ...overrides, listEvents() { throw new Error('must not read'); } }), step).runNarration, null);
});

test('workflow narration rejects mixed attempts and foreign run text', () => {
  const selected = [...events, event(1002, 'tool_start', { attemptId: 'attempt-other' })];
  assert.equal(projectWorkflowStepNarration(store({ listEvents: (_id, { afterSeq }) => selected.filter(entry => entry.seq > afterSeq) }), step).runNarration, null);
  const result = projectWorkflowStepNarration(store({ listEvents: (_id, { afterSeq }) => afterSeq ? [] : [{ ...events[1], runId: 'run-other' }] }), step);
  assert.deepEqual(result.runNarration.segments, []);
});

test('workflow narration redacts a split credential after folding the complete message', () => {
  const secretEvents = [event(1, 'assistant_text_delta', { text: 'sk-example' }), event(2, 'assistant_text_delta', { text: 'NotARealCredential' }), event(3, 'message_end', { role: 'assistant' })];
  const result = projectWorkflowStepNarration(store({ listEvents: (_id, { afterSeq }) => secretEvents.filter(entry => entry.seq > afterSeq) }), step);
  assert.equal(result.runNarration.segments[0].content, '[REDACTED]');
});

test('workflow GET list and item handlers return the event projection without writing history', async () => {
  const { handleChannelWorkflowStepsCollection, handleChannelWorkflowStepItem } = await import('../dist/features/channels/workflows.js');
  const registry = { getStore: () => store({ listChannelWorkflowSteps: () => [step], getChannelWorkflowStep: () => step }) };
  for (const [handler, id] of [[handleChannelWorkflowStepsCollection, 'workflow-1'], [handleChannelWorkflowStepItem, 'step-1']]) {
    let body;
    const response = { setHeader() {}, writeHead(code) { assert.equal(code, 200); }, end(value) { body = JSON.parse(value); } };
    await handler({ method: 'GET', url: '/?cwd=/qa', headers: { host: 'localhost' } }, response, { host: 'localhost', port: 17891 }, registry, id);
    const projected = body.workflowStep ?? body.workflowSteps[0];
    assert.equal(projected.runNarration.runId, 'run-1');
    assert.equal(projected.runNarration.segments.length, 2);
  }
});
