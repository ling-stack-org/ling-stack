import assert from 'node:assert/strict';
import test from 'node:test';
import { learningFixture } from './support/learning-review-fixture.mjs';
import { captureLearningEvidence, captureDecisionLearningEvidence, learningEvidenceCurrent } from '../dist/features/learning/evidence.js';
import { parseLearningDraft } from '../dist/features/learning/extractor.js';
import { commitLearningDraft } from '../dist/features/learning/coordinator.js';

for (const mode of ['normal', 'private', 'channel']) test(`explicit ${mode} turn without a persisted task has bounded owned evidence`, async t => {
  const f = await learningFixture(t);
  const teammate = mode === 'private' ? f.store.listAiTeammates().find(x => x.status !== 'disabled') : undefined;
  const teammateId = teammate?.id ?? 'ling_agent';
  const channelId = mode === 'channel' ? f.channel.id : undefined;
  const thread = f.store.createLingThread({kind:mode === 'channel' ? 'channel_discussion' : mode === 'private' ? 'teammate_direct' : 'conversation',channelId,
    teammateId:mode === 'channel' ? undefined : teammateId,title:'Source conversation',objective:'Evidence'}, f.now);
  const turn = f.store.createLingTurn({threadId:thread.id,kind:'initial_request',title:'Remember the receipt convention',
    userInstruction:'Use signed receipt dates.',createdByActor:'local-user'},f.now);
  const run = f.store.createRun({id:`turn-${mode}`,cwd:f.cwd,threadId:thread.id,turnId:turn.id,taskId:`transient-${mode}`,
    channelId,teammateId,providerName:'fixture',providerModel:'fixture',taskSnapshot:{},providerSnapshot:{},requestSnapshot:{},createdAt:f.now});
  f.store.transitionRunStatus({runId:run.id,expectedStatus:'queued',event:'runner_started',actor:'runner',now:f.now});
  f.store.appendEvent(run.id,'message_end',{role:'assistant',text:'The signed receipt date determines the ledger period.'},f.now);
  f.store.transitionRunStatus({runId:run.id,expectedStatus:'running',event:'runner_succeeded',actor:'runner',now:f.now,endedAt:f.now});
  const e = captureLearningEvidence(f.store,run.id);
  assert.equal(e.taskId,undefined); assert.equal(e.turnId,turn.id); assert.equal(e.channelId,channelId); assert.equal(e.teammateId,teammateId);
  assert.ok(e.items.some(x=>x.kind==='assistant_message' && x.text.includes('signed receipt date')));
  assert.ok(e.items.every(x=>!x.verified)); assert.equal(learningEvidenceCurrent(f.store,e),true);
  const item=e.items.find(x=>x.kind==='assistant_message');
  const draft=parseLearningDraft(JSON.stringify({kind:'memory',title:'Receipt period',body:'Use signed receipt dates.',
    evidence:{evidenceId:item.id,quote:'signed receipt date'}}),e);
  const {job,fence}=f.claim(f.enqueue('explicit',e));
  const result=commitLearningDraft({store:f.store,job,fence,draft,hub:f.hub});
  const memory=f.store.getMemoryObject(result.candidateIds[0]);
  assert.equal(memory.reviewState,'candidate'); assert.equal(memory.ownerId,channelId ?? teammateId);
  f.store.updateLingThread(thread.id,{status:'archived'},new Date().toISOString());
  assert.equal(learningEvidenceCurrent(f.store,e),false);
});

test('only a confirmed active decision can be learned; change, rejection and archive invalidate it',async t=>{
  const f=await learningFixture(t);
  const decision=f.store.createChannelDecision({channelId:f.channel.id,title:'Receipt dates',decision:'Use the signed receipt date.',createdBy:'local-user'},f.now);
  const e=captureDecisionLearningEvidence(f.store,decision.id);
  assert.equal(e.runId,undefined); assert.equal(e.taskId,undefined); assert.equal(e.decisionId,decision.id);
  assert.equal(e.items.length,1); assert.equal(e.items[0].verified,false);
  const draft=parseLearningDraft(JSON.stringify({kind:'memory',title:'Receipt dates',body:'Use the signed receipt date.',
    evidence:{evidenceId:e.items[0].id,quote:'signed receipt date'}}),e);
  const {job,fence}=f.claim(f.enqueue('explicit',e));
  const result=commitLearningDraft({store:f.store,job,fence,draft,hub:f.hub});
  const memory=f.store.getMemoryObject(result.candidateIds[0]);
  assert.equal(memory.scopeType,'channel'); assert.equal(memory.ownerId,f.channel.id); assert.equal(memory.reviewState,'candidate');
  assert.equal(memory.sourceRefs[0].type,'decision'); assert.equal(memory.sourceRefs[0].id,decision.id);
  f.store.updateChannelDecision(decision.id,{decision:'Use the invoice date.'},new Date().toISOString());
  assert.equal(learningEvidenceCurrent(f.store,e),false);
  f.store.updateChannelDecision(decision.id,{status:'rejected'},new Date().toISOString());
  assert.throws(()=>captureDecisionLearningEvidence(f.store,decision.id),/learning_decision_unconfirmed/);
  const pending=f.store.createChannelDecision({channelId:f.channel.id,title:'Draft',decision:'Unconfirmed text.',createdBy:'ai-draft'},f.now);
  assert.throws(()=>captureDecisionLearningEvidence(f.store,pending.id),/learning_decision_unconfirmed/);
});

test('a run without either persisted task or owned turn remains ineligible',async t=>{
 const f=await learningFixture(t);
 f.database.prepare('DELETE FROM tasks WHERE id = ?').run(f.task.id);
 assert.throws(()=>captureLearningEvidence(f.store,f.run.id),/learning_source_scope_unavailable/);
});
