// Public read-only Host APIs. Never emit prompts, execution payloads or secrets.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { LingDaemonClient } from '../../packages/api-client/dist/index.js';
const cwd = new URL('./h09-packaged-human-qa-20261010/profile/workspace', import.meta.url).pathname;
const client = new LingDaemonClient({ baseUrl: 'http://127.0.0.1:17928' });
const workflowId = 'workflow_7560c256-b048-422f-9844-4c4062598cba';
const runId = 'run_1d74e385-1c7a-40fc-b285-fe31130afcc5';
const workUnitId = 'work_unit_2e581045-8858-442a-8761-a736f80db1a8';
const evidence = await client.getChannelWorkflowEvidence(cwd, workflowId);
const response = await client.getRun(runId, cwd), run = response.run ?? response;
const events = (await client.getRunEvents(runId, cwd)).events;
const workEvents = (await client.getWorkUnitEvents(cwd, workUnitId)).events;
const execution = run.requestSnapshot.runnerExecutionInput;
const { fingerprint, ...preparedBody } = execution.preparedInput;
const project = e => ({ id: e.id, seq: e.seq, type: e.type, ts: e.ts,
  toolName: e.data?.toolName, toolCallId: e.data?.toolCallId, attemptId: e.data?.attemptId,
  code: e.data?.code, isError: e.data?.isError, status: e.data?.status });
const capture = {
  capturedAt: new Date().toISOString(), source: 'Public Host APIs; real packaged GUI failure',
  workflowId, run: { id: run.id, status: run.status, channelId: run.channelId,
    workflowStepId: run.workflowStepId, workUnitId, threadId: run.threadId,
    contextViewId: run.contextViewId, startedAt: run.startedAt, endedAt: run.endedAt },
  steps: evidence.steps.map(({ step }) => ({ id: step.id, status: step.status,
    runId: step.runId, participantId: step.toParticipantId, blocker: step.blocker })),
  actions: evidence.actions.map(a => ({ id: a.id, runId: a.runId,
    status: a.status, actionType: a.actionType })),
  approvals: evidence.approvals.map(a => ({ id: a.id, status: a.status })),
  comparisons: {
    taskFieldMatches: Object.fromEntries(['id', 'title', 'prompt', 'channelId']
      .map(k => [k, execution.input.task[k] === run.taskSnapshot[k]])),
    preparedFingerprintMatches: fingerprint === createHash('sha256').update(JSON.stringify(preparedBody)).digest('hex'),
    taskPromptSha256: createHash('sha256').update(execution.input.task.prompt).digest('hex'),
    taskSnapshotPromptSha256: createHash('sha256').update(run.taskSnapshot.prompt).digest('hex'),
  },
  counts: Object.fromEntries([...new Set(events.map(e => e.type))].map(type => [type, events.filter(e => e.type === type).length])),
  events: events.filter(e => ['tool_start', 'tool_end', 'run_error', 'run_end', 'result'].includes(e.type)).map(project),
  webEvents: workEvents.filter(e => e.data?.toolSurface === 'web' || e.type === 'web_evidence_recorded').map(project),
  limits: ['Failed original remains unchanged; no retry or real DB repair.',
    'Loopback regression is not a real model, GUI or network transport result.'],
};
const json = JSON.stringify(capture, null, 2) + '\n';
if (/\bsk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]{12,}/.test(json)) throw new Error('Refusing potential secret');
const path = new URL('./p3-live-20261024/c01-checkpoint-host-lineage.json', import.meta.url);
await writeFile(path, json, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ path: path.pathname, sha256: createHash('sha256').update(json).digest('hex'),
  runStatus: run.status, comparisons: capture.comparisons, steps: capture.steps, counts: capture.counts }, null, 2));
