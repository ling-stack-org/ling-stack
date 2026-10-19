import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import test from "node:test";
import { applyUserInputDeliveryMigration } from "../dist/storage/sqlite/user-input-delivery-migration.js";
import { createSqliteRunStore, resolveRuntimePaths, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../dist/index.js";

const now="2026-09-07T00:00:00.000Z", stopped="2026-09-07T00:00:01.000Z", yielded="2026-09-07T00:00:02.000Z";
const claimedAt="2026-09-07T00:00:03.000Z", expiredAt="2026-09-07T00:00:04.000Z", retryAt="2026-09-07T00:00:05.000Z";
const code=expected=>error=>error.code===expected;
for(const options of [{surface:"private"},{surface:"channel"},{storedTask:true},{workflow:true,storedTask:true}]) {
  test("claim preserves exact surface, Task and workflow scope "+JSON.stringify(options),async t=>{
    const f=await fixture(t,options);
    const before={run:f.store.getRun(f.run.id),unit:f.store.getWorkUnit(f.unit.id),task:f.store.getTask(f.task.id),
      sibling:f.sibling?f.store.getChannelWorkflowStep(f.sibling.id):undefined};
    assert.equal(f.claim().status,"claimed");
    const seed=f.store.getUserInputContinuationSeed(f.thread.id,f.receipt.deliveryId);
    assert.deepEqual(seed.source,JSON.parse(JSON.stringify(f.request.source)));
    assert.equal(seed.source.workflowStepId,f.step?.id);
    assert.equal(seed.source.taskBinding.kind,options.storedTask?"stored_task":"run_snapshot");
    assert.deepEqual(f.store.getRun(f.run.id),before.run);
    assert.deepEqual(f.store.getWorkUnit(f.unit.id),before.unit);
    assert.deepEqual(f.store.getTask(f.task.id),before.task);
    if(f.sibling)assert.deepEqual(f.store.getChannelWorkflowStep(f.sibling.id),before.sibling);
  });
}
test("cancelled workflow parent makes its unconsumed answer obsolete",async t=>{
  const f=await fixture(t,{workflow:true,storedTask:true});
  f.db.prepare("UPDATE channel_workflows SET status='cancelled' WHERE id=?").run(f.workflow.id);
  assert.equal(f.claim(),null);assert.equal(f.get().status,"obsolete");
});

test("migration extends an existing pending outbox without changing its accepted identity",t=>{
  const database=new DatabaseSync(":memory:");t.after(()=>database.close());
  database.exec("CREATE TABLE user_input_deliveries(delivery_id TEXT PRIMARY KEY,answer_id TEXT NOT NULL,consumer_work_unit_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);"
    +"CREATE TABLE migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);"
    +"INSERT INTO user_input_deliveries VALUES ('delivery','answer','unit','pending','2026-09-07T00:00:01.000Z')");
  const context={database,hasMigration:version=>!!database.prepare("SELECT 1 FROM migrations WHERE version=?").get(version),
    recordMigration:(version,name)=>database.prepare("INSERT INTO migrations VALUES (?,?)").run(version,name)};
  applyUserInputDeliveryMigration(context);
  const row=database.prepare("SELECT * FROM user_input_deliveries").get();
  assert.equal(row.answer_id,"answer");assert.equal(row.consumer_work_unit_id,"unit");assert.equal(row.status,"pending");
  assert.equal(row.updated_at,row.created_at);assert.equal(row.status_revision,1);assert.equal(row.successor_run_id,null);
  applyUserInputDeliveryMigration(context);assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migrations").get().n,1);
});
test("failed migration rolls back columns and marker as one transaction",t=>{
  const database=new DatabaseSync(":memory:");t.after(()=>database.close());
  database.exec("CREATE TABLE user_input_deliveries(delivery_id TEXT PRIMARY KEY,answer_id TEXT NOT NULL,consumer_work_unit_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL)");
  assert.throws(()=>applyUserInputDeliveryMigration({database,hasMigration:()=>false,recordMigration:()=>{throw new Error("migration commit refusal")}}),/migration commit refusal/);
  assert.ok(!database.prepare("PRAGMA table_info(user_input_deliveries)").all().some(row=>row.name==="claim_token"));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migrations").get().n,0);
});
test("migration COMMIT failure rolls back DDL and permits a clean retry",t=>{
  const database=new DatabaseSync(":memory:");t.after(()=>database.close());database.exec("PRAGMA foreign_keys=ON");
  database.exec("CREATE TABLE user_input_deliveries(delivery_id TEXT PRIMARY KEY,answer_id TEXT NOT NULL,consumer_work_unit_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE migrations(version INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
  const context={database,hasMigration:()=>false,recordMigration:version=>database.prepare("INSERT INTO migrations VALUES (?)").run(version)};
  assert.throws(()=>applyUserInputDeliveryMigration(context),/FOREIGN KEY/);
  assert.ok(!database.prepare("PRAGMA table_info(user_input_deliveries)").all().some(row=>row.name==="claim_token"));
  database.exec("INSERT INTO parent VALUES (133)");applyUserInputDeliveryMigration(context);
  assert.ok(database.prepare("PRAGMA table_info(user_input_deliveries)").all().some(row=>row.name==="claim_token"));
});
test("persisted delivery and claim corruption fail closed",async t=>{
  for(const sql of [
    "UPDATE user_input_deliveries SET status='claimed'",
    "UPDATE user_input_deliveries SET attempt_count=1",
    "UPDATE user_input_deliveries SET updated_at='invalid'",
    "UPDATE user_input_deliveries SET successor_run_id='invalid id'",
    "UPDATE user_input_deliveries SET consumer_work_unit_id='foreign'",
  ]) {
    const f=await fixture(t);f.db.exec(sql);assert.throws(()=>f.get(),code("invalid_record"));
  }
});
test("an applied row cannot be reclaimed or cancelled by the original source",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.db.exec("UPDATE user_input_deliveries SET status='applied',claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL");
  assert.throws(()=>f.claim({expectedRevision:2},expiredAt),code("delivery_conflict"));
  assert.throws(()=>f.store.cancelUserInputWait({threadId:f.thread.id,sourceRunId:f.run.id},claimedAt),code("source_conflict"));
  assert.equal(f.get().successorRunId,first.successorRunId);
});
test("blocked checkpoint stays pending and does not create a fresh task",async t=>{
  const f=await fixture(t);f.db.exec("UPDATE user_input_requests SET wait_status='blocked'");
  assert.throws(()=>f.claim(),code("delivery_not_ready"));assert.equal(f.get().successorRunId,null);
});
test("a corrupted yield checkpoint prevents a claim",async t=>{
  const f=await fixture(t);
  f.db.prepare("UPDATE user_input_requests SET wait_checkpoint_json='{}' WHERE request_id=?").run(f.request.requestId);
  assert.throws(()=>f.claim(),code("invalid_record"));
});
test("delivery invalidations never publish claim tokens or answer body",async t=>{
  const f=await fixture(t);const first=f.claim();
  const json=JSON.stringify(f.db.prepare("SELECT * FROM control_plane_events WHERE entity_type='user_input_delivery'").all());
  assert.ok(!json.includes(first.claim.token));assert.ok(!json.includes("深色"));
  assert.ok(json.includes(first.deliveryId)&&json.includes(first.successorRunId));
});

test("due deliveries include expired leases and retryable failures, not live claims or future retries",async t=>{
  const f=await fixture(t);
  const due=at=>f.store.listDueUserInputDeliveries({threadId:f.thread.id},at);
  assert.deepEqual(due(claimedAt).map(d=>d.deliveryId),[f.receipt.deliveryId]);
  const first=f.claim();assert.deepEqual(due(claimedAt),[]);
  assert.equal(due(expiredAt)[0].claim.token,first.claim.token);
  f.retry(first);assert.deepEqual(due(expiredAt),[]);
  assert.equal(due(retryAt)[0].status,"failed");
  assert.deepEqual(f.store.listDueUserInputDeliveries({threadId:"foreign"},retryAt),[]);
  for(const limit of [0,501,1.1])assert.throws(()=>f.store.listDueUserInputDeliveries({threadId:f.thread.id,limit},retryAt),code("invalid_input"));
});
test("a clock rollback before committed yield cannot authorize continuation",async t=>{
  const f=await fixture(t);assert.throws(()=>f.claim({},stopped),code("delivery_not_ready"));
  assert.equal(f.get().status,"pending");
});
test("a terminal source Turn cannot be resumed by a stale wait record",async t=>{
  const f=await fixture(t);f.db.prepare("UPDATE ling_turns SET status='cancelled' WHERE id=?").run(f.turn.turnId);
  assert.equal(f.claim(),null);assert.equal(f.get().status,"obsolete");
});
test("an archivedAt flag also prevents delivery even without archived status",async t=>{
  const f=await fixture(t);f.db.prepare("UPDATE ling_threads SET archived_at=? WHERE id=?").run(claimedAt,f.thread.id);
  assert.equal(f.claim(),null);assert.equal(f.get().status,"obsolete");
});
test("changed source attempt, task snapshot and consumer identity cannot borrow the wait",async t=>{
  for(const alter of [
    db=>db.prepare("UPDATE work_unit_attempts SET runtime_instance_id='changed'").run(),
    db=>db.prepare("UPDATE run_sessions SET teammate_id='another-agent'").run(),
    db=>db.prepare("UPDATE work_units SET teammate_id='another-agent'").run(),
  ]) {
    const f=await fixture(t);alter(f.db);
    assert.throws(()=>f.claim(),code("source_conflict"));
  }
});
test("canonical answer actor must remain the real user",async t=>{
  const f=await fixture(t);
  f.db.prepare("UPDATE conversation_items SET actor_type='ling_agent' WHERE id=?").run(f.receipt.answerItemId);
  assert.throws(()=>f.claim(),code("invalid_record"));
});
test("a changed request participant is not accepted by merely preserving its payload IDs",async t=>{
  const f=await fixture(t);
  f.db.prepare("UPDATE conversation_items SET actor_id='other-agent' WHERE id=?").run(f.request.itemId);
  assert.throws(()=>f.claim(),code("invalid_record"));
});
test("retry after cancellation or archival cannot reactivate the outbox",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.store.updateLingThread(f.thread.id,{status:"archived",archivedAt:claimedAt},claimedAt);
  assert.equal(f.retry(first).status,"obsolete");
  assert.equal(f.claim({expectedRevision:3}),null);
});
test("retry schedules reject unbounded error text and backward timestamps",async t=>{
  const f=await fixture(t);const first=f.claim();
  for(const changes of [{errorCode:"raw exception text"},{retryAt:stopped},{retryAt:"2026-09-07T02:00:00.000Z"}]) {
    assert.throws(()=>f.retry(first,changes),code("invalid_input"));
  }
  assert.deepEqual(f.get(),first);
});
test("retry commit failure does not clear the current claim",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.db.exec("CREATE TRIGGER fail_retry BEFORE UPDATE ON user_input_deliveries WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'retry failure'); END");
  assert.throws(()=>f.retry(first),/retry failure/);assert.deepEqual(f.get(),first);
});
test("cancel commit failure restores both logical wait and claimed delivery",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.db.exec("CREATE TABLE cancel_delivery_commit_failure(id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER fail_cancel_delivery AFTER UPDATE ON user_input_deliveries WHEN NEW.status='obsolete' BEGIN INSERT INTO cancel_delivery_commit_failure VALUES ('missing'); END");
  assert.throws(()=>f.store.cancelUserInputWait({threadId:f.thread.id,sourceRunId:f.run.id},claimedAt),/FOREIGN KEY/);
  assert.deepEqual(f.get(),first);assert.equal(f.store.getUserInputWait(f.thread.id,f.request.requestId).status,"waiting");
  assert.equal(f.store.getWorkUnit(f.unit.id).status,"waiting_for_input");
});
test("expired rows do not issue a claim for an already replaced logical owner",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.store.createWorkUnitAttempt({workUnitId:f.unit.id,attemptNumber:2,runtimeInstanceId:"replacement",
    runnerId:"runner_pi_embedded",status:"created",now:claimedAt});
  assert.throws(()=>f.claim({expectedRevision:2},expiredAt),code("source_conflict"));assert.deepEqual(f.get(),first);
});
test("due-list and get do not swallow infrastructure errors as corrupt records",async t=>{
  const f=await fixture(t),read=f.store.getConversationItem.bind(f.store);
  f.store.getConversationItem=()=>{throw new Error("storage unavailable")};
  try {
    assert.throws(()=>f.get(),/storage unavailable/);
    assert.throws(()=>f.store.listDueUserInputDeliveries({threadId:f.thread.id},claimedAt),/storage unavailable/);
  } finally { f.store.getConversationItem=read; }
});
async function fixture(t,{wait=true,optional=false,surface="normal",workflow=false,storedTask=false}={}) {
  const cwd=await mkdtemp(join(tmpdir(),"ling-input-delivery-"));
  const f={cwd,store:createSqliteRunStore(cwd)};
  f.db=new DatabaseSync(resolveRuntimePaths(cwd).databasePath);f.db.exec("PRAGMA foreign_keys=ON");
  t.after(async()=>{f.db.close();f.store.close();await rm(cwd,{recursive:true,force:true})});
  if(workflow||storedTask||surface==="channel") f.channel=f.store.createChannel({name:"Delivery source",boundPath:cwd},now);
  const channelId=surface==="channel"||workflow?f.channel.id:undefined;
  if(workflow) {
    f.workflow=f.store.createChannelWorkflow({channelId,title:"Workflow",objective:"Continue",status:"running",createdBy:"local-user"},now);
    f.step=f.store.createChannelWorkflowStep({workflowId:f.workflow.id,title:"Ask",prompt:"Ask",toParticipantId:"ling_agent",toParticipantLabel:"Ling",status:"running"},now);
    f.sibling=f.store.createChannelWorkflowStep({workflowId:f.workflow.id,title:"Independent",prompt:"Independent",toParticipantId:"ling_agent",toParticipantLabel:"Ling",status:"running"},now);
  }
  f.thread=f.store.createLingThread({kind:surface==="private"?"teammate_direct":channelId?"channel_discussion":"conversation",
    channelId,teammateId:surface==="private"?"ling_agent":undefined,title:"Delivery",objective:"Continue exact work"},now);
  f.turn=f.store.appendConversationUserTurn({threadId:f.thread.id,channelId,title:"Source",userInstruction:"Build",idempotencyKey:"source",
    payload:{body:"Build",format:"markdown",mentions:[],attachmentIds:[],linkPreviewIds:[],fileRefs:[]}},now);
  f.unit=f.store.createWorkUnit({workspaceId:DEFAULT_WORKSPACE_ID,kind:"task_run",ownerType:"run",ownerId:"source-run",
    idempotencyKey:"unit",status:"running",createdByActor:"system",request:{},now});
  f.attempt=f.store.createWorkUnitAttempt({workUnitId:f.unit.id,attemptNumber:1,runtimeInstanceId:"source-runtime",
    runnerId:"runner_pi_embedded",status:"started",now});
  f.task=storedTask?f.store.createTask({channelId:f.channel.id,title:"Delivery task",prompt:"Ask"},now):{id:"snapshot-task"};
  f.run=f.store.createRun({id:"source-run",cwd,taskId:f.task.id,channelId,workflowStepId:f.step?.id,threadId:f.thread.id,turnId:f.turn.turnId,workUnitId:f.unit.id,
    providerName:"fixture",providerModel:"fixture",taskSnapshot:{},providerSnapshot:{},requestSnapshot:{},createdAt:now});
  f.store.transitionRunStatus({runId:f.run.id,expectedStatus:"queued",event:"runner_started",actor:"runner",now});
  f.store.linkRunToWorkUnit(f.run.id,f.unit.id,now);
  if(storedTask) {
    f.store.transitionTaskStatus({taskId:f.task.id,expectedStatus:"todo",event:"claim",actor:"system",now});
    f.store.transitionTaskStatus({taskId:f.task.id,expectedStatus:"claimed",event:"start_run",actor:"system",currentRunId:f.run.id,now});
  }
  if(workflow) f.store.updateChannelWorkflowStep(f.step.id,{runId:f.run.id,taskId:f.task.id},now);
  f.request=f.store.createUserInputRequest({sourceRunId:f.run.id,sourceItemId:f.turn.item.id,sourceFence:toRuntimeAttemptFence(f.attempt),
    toolCallId:"question",idempotencyKey:"question",toolInput:{schemaVersion:1,waitMode:optional?"optional":"required",
      questions:[{questionId:"theme",prompt:"选择主题",required:true,allowFreeText:true,options:[]}]}},now).request;
  f.receipt=f.store.submitUserInputAnswer({threadId:f.thread.id,submission:{schemaVersion:1,requestId:f.request.requestId,
    expectedVersion:1,expectedStatusRevision:1,idempotencyKey:"answer",answers:[{questionId:"theme",kind:"text",text:"深色"}]}},stopped);
  if(wait&&!optional)f.store.commitUserInputYield({threadId:f.thread.id,requestId:f.request.requestId,expectedRequestVersion:1,
    sourceFence:toRuntimeAttemptFence(f.attempt),quiescence:{kind:"runner_quiesced",runnerId:f.attempt.runnerId,stoppedAt:stopped,lastRunEventSeq:0}},yielded);
  f.input={threadId:f.thread.id,deliveryId:f.receipt.deliveryId,expectedRevision:1,ownerId:"worker-a",leaseMs:1000};
  f.get=()=>f.store.getUserInputDelivery(f.thread.id,f.receipt.deliveryId);
  f.claim=(changes={},at=claimedAt)=>f.store.claimUserInputDelivery({...f.input,...changes},at);
  f.retry=(delivery,changes={},at=claimedAt)=>f.store.retryUserInputDelivery({
    threadId:f.thread.id,deliveryId:delivery.deliveryId,expectedRevision:delivery.revision,
    ownerId:delivery.claim.ownerId,claimToken:delivery.claim.token,retryAt,errorCode:"receiver_unavailable",...changes},at);
  return f;
}
test("claim reserves one stable successor identity without starting or marking delivery applied",async t=>{
  const f=await fixture(t);const original=f.get();
  assert.equal(original.status,"pending");assert.equal(original.revision,1);assert.equal(original.claim,null);
  const result=f.claim();
  assert.equal(result.status,"claimed");assert.equal(result.revision,2);assert.equal(result.attemptCount,1);
  assert.equal(result.claim.ownerId,"worker-a");assert.equal(result.claim.expiresAt,expiredAt);
  assert.match(result.successorRunId,/^run_/);assert.equal(f.store.getRun(result.successorRunId),undefined);
  assert.equal(f.store.getRun(f.run.id).status,"yielded");
  assert.equal(f.store.getWorkUnit(f.unit.id).status,"waiting_for_input");
  assert.equal(f.store.getUserInputWait(f.thread.id,f.request.requestId).status,"waiting");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM run_sessions").get().n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_delivery'").get().n,1);
});
test("live lease and old revisions cannot be stolen",async t=>{
  const f=await fixture(t);const first=f.claim();
  assert.throws(()=>f.claim({ownerId:"worker-b"}),code("delivery_conflict"));
  assert.throws(()=>f.claim({ownerId:"worker-b",expectedRevision:2}),code("delivery_conflict"));
  assert.deepEqual(f.get(),first);
});
test("expired lease is reclaimed with new token and the same successor identity",async t=>{
  const f=await fixture(t);const first=f.claim();
  const next=f.claim({ownerId:"worker-b",expectedRevision:first.revision},expiredAt);
  assert.equal(next.successorRunId,first.successorRunId);assert.notEqual(next.claim.token,first.claim.token);
  assert.equal(next.attemptCount,2);assert.equal(next.revision,3);
  assert.throws(()=>f.retry(first),code("delivery_conflict"));assert.deepEqual(f.get(),next);
});
test("retry preserves immutable receipt and enforces next attempt time",async t=>{
  const f=await fixture(t);const first=f.claim();const failed=f.retry(first);
  assert.equal(failed.status,"failed");assert.equal(failed.claim,null);assert.equal(failed.retryAt,retryAt);
  assert.equal(failed.successorRunId,first.successorRunId);
  assert.throws(()=>f.claim({expectedRevision:failed.revision}),code("delivery_not_ready"));
  const next=f.claim({expectedRevision:failed.revision},retryAt);
  assert.equal(next.successorRunId,first.successorRunId);assert.equal(next.attemptCount,2);
  assert.equal(next.status,"claimed");assert.equal(next.retryAt,null);assert.equal(next.lastErrorCode,null);
  assert.notEqual(next.claim.token,first.claim.token);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user_input_answers").get().n,1);
  assert.equal(f.store.getConversationItem(f.receipt.answerItemId).kind,"user_input_answer");
});
test("expired claimant cannot schedule retries or mutate the replacement",async t=>{
  const f=await fixture(t);const first=f.claim();assert.throws(()=>f.retry(first,{},expiredAt),code("delivery_conflict"));
  assert.equal(f.get().status,"claimed");
});
for(const bad of [{claimToken:"wrong"},{ownerId:"other"},{expectedRevision:1}]) {
  test("retry requires exact live claim "+JSON.stringify(bad),async t=>{
    const f=await fixture(t);const first=f.claim();
    assert.throws(()=>f.retry(first,bad),code("delivery_conflict"));assert.deepEqual(f.get(),first);
  });
}
for(const options of [{wait:false},{optional:true}]) {
  test("early or optional answer cannot independently start a continuation "+JSON.stringify(options),async t=>{
    const f=await fixture(t,options);assert.throws(()=>f.claim(),code("delivery_not_ready"));
    assert.equal(f.get().status,"pending");assert.equal(f.get().successorRunId,null);
  });
}
test("thread scope hides existence for get, claim and retry",async t=>{
  const f=await fixture(t);assert.equal(f.store.getUserInputDelivery("wrong",f.receipt.deliveryId),undefined);
  assert.throws(()=>f.claim({threadId:"wrong"}),code("not_found"));
  const first=f.claim();assert.throws(()=>f.retry(first,{threadId:"wrong"}),code("not_found"));
});
test("reopen retains lease and reuses the reserved successor after expiration",async t=>{
  const f=await fixture(t);const first=f.claim();f.store.close();f.store=createSqliteRunStore(f.cwd);
  assert.deepEqual(f.get(),first);assert.equal(f.claim({expectedRevision:first.revision},expiredAt).successorRunId,first.successorRunId);
});
test("cancellation invalidates a claimed delivery only before any successor exists",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.store.cancelUserInputWait({threadId:f.thread.id,sourceRunId:f.run.id},claimedAt);
  const obsolete=f.get();assert.equal(obsolete.status,"obsolete");assert.equal(obsolete.claim,null);
  assert.equal(obsolete.revision,3);assert.equal(obsolete.successorRunId,first.successorRunId);
  assert.throws(()=>f.retry(first),code("delivery_conflict"));assert.equal(f.claim({expectedRevision:obsolete.revision}),null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user_input_answers").get().n,1);
});
test("existing successor prevents lease reclamation, retry and old-source cancellation",async t=>{
  const f=await fixture(t);const first=f.claim();
  f.store.createRun({id:first.successorRunId,cwd:f.cwd,taskId:"snapshot-task",threadId:f.thread.id,
    turnId:f.turn.turnId,providerName:"fixture",providerModel:"fixture",taskSnapshot:{},providerSnapshot:{},requestSnapshot:{},createdAt:claimedAt});
  assert.throws(()=>f.claim({expectedRevision:first.revision},expiredAt),code("delivery_conflict"));
  assert.throws(()=>f.retry(first),code("delivery_conflict"));
  assert.throws(()=>f.store.cancelUserInputWait({threadId:f.thread.id,sourceRunId:f.run.id},claimedAt),code("source_conflict"));
  assert.equal(f.store.getRun(first.successorRunId).status,"queued");
});
test("archived consumer becomes obsolete without waking a task",async t=>{
  const f=await fixture(t);f.store.updateLingThread(f.thread.id,{status:"archived",archivedAt:claimedAt},claimedAt);
  assert.equal(f.claim(),null);assert.equal(f.get().status,"obsolete");
});
test("completed optional source becomes obsolete instead of being resurrected",async t=>{
  const f=await fixture(t,{optional:true});f.store.markRunSucceeded(f.run.id,claimedAt);
  assert.equal(f.claim(),null);assert.equal(f.get().status,"obsolete");
});
test("tampered answer is rejected before a claim can be created",async t=>{
  const f=await fixture(t);f.db.prepare("UPDATE user_input_answers SET submission_json='{}' WHERE answer_id=?").run(f.receipt.answerId);
  assert.throws(()=>f.claim(),code("invalid_record"));assert.equal(f.db.prepare("SELECT status FROM user_input_deliveries").get().status,"pending");
});
test("wrong canonical answer lineage is rejected",async t=>{
  const f=await fixture(t);f.db.prepare("UPDATE conversation_items SET payload_json='{}' WHERE id=?").run(f.receipt.answerItemId);
  assert.throws(()=>f.claim(),code("invalid_record"));
});
for(const leaseMs of [0,-1,60_001,1.1,NaN]) {
  test("invalid lease bound is rejected: "+leaseMs,async t=>{
    const f=await fixture(t);assert.throws(()=>f.claim({leaseMs}),code("invalid_input"));
  });
}
test("claim and invalidation event roll back together when commit fails",async t=>{
  const f=await fixture(t);
  f.db.exec("CREATE TABLE delivery_commit_failure(id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER fail_claim AFTER UPDATE ON user_input_deliveries BEGIN INSERT INTO delivery_commit_failure VALUES ('missing'); END");
  const before=f.get();assert.throws(()=>f.claim(),/FOREIGN KEY/);assert.deepEqual(f.get(),before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_delivery'").get().n,0);
});
test("two actual connections cannot both claim the same delivery",{timeout:15_000},async t=>{
  const f=await fixture(t);const barrier=new SharedArrayBuffer(4), flag=new Int32Array(barrier);
  const workerScript=[
    'const {parentPort,workerData}=require("node:worker_threads");',
    '(async()=>{const {createSqliteRunStore}=await import(workerData.module);const store=createSqliteRunStore(workerData.cwd);',
    'parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),0,0);',
    'try{parentPort.postMessage({claimed:store.claimUserInputDelivery(workerData.input,workerData.now)})}',
    'catch(e){parentPort.postMessage({error:e.code||e.message})}finally{store.close()}})().catch(e=>{throw e});'
  ].join("\n");
  const workers=[0,1].map(i=>new Worker(workerScript,{eval:true,workerData:{
    module:new URL("../dist/index.js",import.meta.url).href,cwd:f.cwd,barrier,input:{...f.input,ownerId:"worker-"+i},now:claimedAt}}));
  t.after(()=>Promise.all(workers.map(w=>w.terminate())));
  await Promise.all(workers.map(w=>once(w,"message")));
  const results=workers.map(w=>once(w,"message").then(([message])=>message));
  Atomics.store(flag,0,1);Atomics.notify(flag,0,2);
  const values=await Promise.all(results);
  assert.equal(values.filter(value=>value.claimed).length,1);
  assert.deepEqual(values.filter(value=>value.error).map(value=>value.error),["delivery_conflict"]);
  assert.equal(f.get().attemptCount,1);
});
