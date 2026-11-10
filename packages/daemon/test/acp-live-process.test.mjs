import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "@ling-stack/core";
import { AcpLiveClient } from "../dist/runtime/acp/live-client.js";
import { AcpApprovalJournal } from "../dist/runtime/acp/approval-journal.js";
import { KimiActionPreparer } from "../dist/runtime/acp/kimi-action-preparation.js";

test("ACP cancellation observer failure closes naturally without a residual cancel timer", { timeout: 8000 }, async t => {
  const module = new URL("../dist/runtime/acp/live-client.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {PassThrough, Writable} from "node:stream";
    import {AcpLiveClient} from ${JSON.stringify(module)};
    const output = new PassThrough();
    const send = value => output.write(JSON.stringify(value)+"\\n");
    const result = (id,value) => send({jsonrpc:"2.0",id,result:value});
    const asked = Promise.withResolvers();
    const input = new Writable({write(bytes,encoding,done) {
      const m=JSON.parse(bytes.toString());
      if(m.method==="initialize") result(m.id,{protocolVersion:1,agentInfo:{name:"Kimi Code CLI",version:"fixture"},agentCapabilities:{},authMethods:[]});
      if(m.method==="session/new") result(m.id,{sessionId:"session"});
      if(m.method==="session/prompt") send({jsonrpc:"2.0",id:"permission",method:"session/request_permission",params:{sessionId:"session",toolCall:{toolCallId:"tool",title:"Fixture"},options:[{kind:"allow_once",optionId:"once",name:"Once"}]}});
      done();
    }});
    const client=new AcpLiveClient({input,output,signal:new AbortController().signal,engineId:"kimi-acp",expectedVersion:"fixture",cancelTimeoutMs:60000,
      onSessionAccepted:async()=>{},onPromptSubmitting:async()=>{},onUpdate:async()=>{},
      onPermission:async()=>{asked.resolve();return new Promise(()=>{});},onPermissionReplyOutcome:()=>{throw new Error("fixture persistence failure");}});
    await client.initialize();await client.openSession({cwd:"/tmp/owned-acp-cancel"});
    const handle=await client.startPrompt([{type:"text",text:"Synthetic"}]);await asked.promise;
    await assert.rejects(handle.cancel(),{code:"host_commit_failed"});
    await assert.rejects(handle.completed,{code:"host_commit_failed"});
    client.close();await client.closed;
  `], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "close");
  child.stdout.resume(); child.stderr.resume();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
  t.after(() => { clearTimeout(deadline); child.kill(); });
  const [code] = await exited;
  clearTimeout(deadline);
  assert.equal(timedOut, false, "closed client left its 60-second cancellation timer alive");
  assert.equal(code, 0);
});

const now = "2026-09-09T00:00:00.000Z";
async function journal(t, engineId) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-acp-journal-peer-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "ACP fixture", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "ACP fixture", prompt: "Synthetic" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "ACP fixture", objective: "Synthetic" }, now);
  store.createRun({ id: "run_acp_peer", cwd, taskId: task.id, channelId: channel.id, threadId: thread.id,
    providerName: "native", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const work = store.createWorkUnit({ id: "wu_acp_peer", workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
    ownerType: "run", ownerId: "run_acp_peer", idempotencyKey: "acp-fixture", createdByActor: "user", request: {},
    linkedRunId: "run_acp_peer", runnerId: engineId, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1, runtimeInstanceId: "acp-runtime", runnerId: engineId, now });
  store.linkRunToWorkUnit("run_acp_peer", work.id, now);
  const fence = toRuntimeAttemptFence(attempt);
  const entry = store.reserveNativeExecution({ runId: "run_acp_peer", generation: 1, fence,
    selection: { engineId, profileId: "owned-fixture", profileRevision: 1, profileFingerprint: "a".repeat(64), configurationFingerprint: "b".repeat(64) } }, now);
  const key = { submissionId: entry.submission.id, fence };
  const route = engineId === "openclaw-acp" ? store.prepareNativeOpenClawSession({ ...key, agentId: "fixture" }, now) : undefined;
  return { cwd, store, key, route };
}

for (const mode of ["changed", "restored", "terminal", "cosmetic"]) {
  test(`Kimi receipt journal fences ${mode} input before SDK dispatch`, { timeout: 5000 }, async t => {
    const { cwd, store, key } = await journal(t, "kimi-acp");
    const actions = new KimiActionPreparer({ sessionId: "owned-session", cwd,
      policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [cwd] } });
    const saved = new AcpApprovalJournal(store, key, actions, () => now);
    const output = new PassThrough();
    const send = messages => output.write(messages.map(message => JSON.stringify(message)).join("\n") + "\n");
    const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
    const update = value => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "owned-session", update: {
      sessionUpdate: "tool_call_update", toolCallId: "1:bash", ...value } } });
    const permission = { jsonrpc: "2.0", id: "request", method: "session/request_permission", params: {
      sessionId: "owned-session", toolCall: { toolCallId: "1:bash", title: "Bash" }, options: [
        { optionId: "approve_once", kind: "allow_once", name: "Once" },
        { optionId: "approve_always", kind: "allow_always", name: "Session" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ] } };
    const wire = [];
    const observations = [];
    let promptId;
    let approvalId;
    let asked = 0;
    const input = new Writable({ write(bytes, _encoding, done) {
      const message = JSON.parse(bytes.toString()); wire.push(message);
      if (message.method === "initialize") send([result(message.id, { protocolVersion: 1,
        agentInfo: { name: "Kimi Code CLI", version: "fixture" }, agentCapabilities: {}, authMethods: [] })]);
      if (message.method === "session/new") send([result(message.id, { sessionId: "owned-session" })]);
      if (message.method === "session/prompt") {
        promptId = message.id;
        const messages = [update({ sessionUpdate: "tool_call", title: "Bash", kind: "execute", status: "in_progress",
          rawInput: { command: "whois first.example" } }), permission];
        if (mode === "terminal") messages.push(result(promptId, { stopReason: "cancelled" }));
        else if (mode === "cosmetic") messages.push(update({ title: "New progress summary" }));
        else {
          messages.push(update({ rawInput: { command: "whois later.example" } }));
          if (mode === "restored") messages.push(update({ rawInput: { command: "whois first.example" } }));
        }
        send(messages);
      }
      if (message.id === "request" && message.result?.outcome?.outcome === "selected") {
        setImmediate(() => send([result(promptId, { stopReason: "end_turn" })]));
      }
      done();
    } });
    const client = new AcpLiveClient({ input, output, signal: new AbortController().signal,
      engineId: "kimi-acp", expectedVersion: "fixture",
      onSessionAccepted: async binding => { store.bindNativeExecutionSession({ ...key, nativeSessionId: binding.sessionId }, now); },
      onPromptSubmitting: async () => {},
      onPromptSending: value => { store.beginNativeSubmission({ ...key, nativePromptRequestId: value.requestId }, now); },
      onPromptAccepted: value => { store.acceptNativeSubmission({ ...key, nativePromptRequestId: value.requestId }, now); },
      onUpdateReceived: event => { actions.receive(event); }, onUpdate: async () => {},
      onPermissionReceived: (request, signal) => { approvalId = saved.create(request, signal).id; },
      onPermission: async (request, signal) => {
        asked++; const approval = saved.create(request, signal);
        store.approveApprovalRequest(approval.id, {}, now); return "approve_once";
      },
      onPermissionReplySending: (request, reply) => { saved.beforeWrite(request, reply); },
      onPermissionReplyOutcome: value => { observations.push(value); saved.observe(value); },
    });
    t.after(async () => { client.close(); await client.closed; });
    await client.initialize(); await client.openSession({ cwd });
    const handle = await client.startPrompt([{ type: "text", text: "Owned fixture" }]);
    if (mode === "changed" || mode === "restored") await assert.rejects(handle.completed, { code: "host_commit_failed" });
    else assert.equal((await handle.completed).stopReason, mode === "terminal" ? "cancelled" : "end_turn");
    assert.equal(store.getApprovalRequest(approvalId).payload.command, "whois first.example");
    assert.equal(store.getApprovalRequest(approvalId).status, mode === "cosmetic" ? "approved" : "cancelled");
    assert.deepEqual(observations, [{ requestId: "request", outcome: mode === "cosmetic" ? "written" : "not_written" }]);
    assert.equal(wire.some(message => message.result?.outcome?.optionId === "approve_once"), mode === "cosmetic");
    assert.equal(asked, mode === "terminal" ? 0 : 1);
  });
}

for (const engineId of ["kimi-acp", "openclaw-acp"]) for (const action of ["approve", "deny", "cancel", "expired", "stale"]) {
  test(`${engineId} owned child supports live ${action} without launching a real engine`, { timeout: 5000 }, async t => {
    const { cwd, store, key, route } = await journal(t, engineId);
    const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/acp-live-peer.mjs", import.meta.url))], {
      env: { LING_ACP_PEER_ENGINE: engineId }, stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    child.stderr.resume();
    const wire = [];
    child.on("message", message => wire.push(message));
    const abort = new AbortController();
    const asked = Promise.withResolvers();
    const decision = Promise.withResolvers();
    const live = Promise.withResolvers();
    const events = [];
    let permissionSignal;
    let requestId;
    let approvalId;
    let time = now;
    const observations = [];
    const allowOption = engineId === "kimi-acp" ? "approve_once" : "once";
    const kimi = engineId === "kimi-acp" ? new KimiActionPreparer({ sessionId: "owned-session", cwd,
      policy: { toolDecisions: { bash: "ask" }, allowedWritePaths: [cwd] } }) : undefined;
    // OpenClaw still uses synthetic preparation; Kimi now consumes pinned-source-shaped rawInput.
    const approvalJournal = new AcpApprovalJournal(store, key, kimi ?? { prepare: () => ({ kind: "action",
      policyDecision: { decision: "ask", reason: "Synthetic fixture" }, approval: { actionType: "bash", risk: "medium",
        toolCallId: "owned-tool", title: "Approve synthetic fixture", description: "No shell is executed",
        payload: { type: "bash", command: "whois example.com", cwd, riskFlags: [] } },
    }) }, () => time);
    const client = new AcpLiveClient({ input: child.stdin, output: child.stdout, signal: abort.signal, engineId,
      expectedVersion: "owned-peer-1", requestTimeoutMs: 1500, turnTimeoutMs: 3000,
      onSessionAccepted: async binding => { store.bindNativeExecutionSession({ ...key, nativeSessionId: binding.sessionId }, now); },
      onPromptSubmitting: async () => {},
      onPromptSending: value => {
        requestId = value.requestId;
        assert.equal(store.beginNativeSubmission({ ...key, nativePromptRequestId: requestId }, now).status, "submission_pending");
      },
      onPromptAccepted: value => {
        assert.equal(value.requestId, requestId);
        assert.equal(store.acceptNativeSubmission({ ...key, nativePromptRequestId: value.requestId }, now).status, "accepted");
      },
      onUpdateReceived: update => { kimi?.receive(update); },
      onPermissionReceived: (request, signal) => { approvalId = approvalJournal.create(request, signal).id; },
      onUpdate: async update => {
        if (update.update.sessionUpdate !== "agent_message_chunk") return;
        store.appendNativeRunEvents({ ...key, nativePromptRequestId: requestId, nativeSessionId: update.sessionId,
          firstSequence: events.length + 1, events: [{ type: "assistant_text_delta", data: { text: update.update.content.text } }] }, now);
        events.push(update); if (update.update.content.text === "中文 streaming during decision") live.resolve();
      },
      onPermission: async (request, signal) => {
        permissionSignal = signal;
        approvalId = approvalJournal.create(request, signal).id;
        asked.resolve(); return decision.promise;
      },
      onPermissionReplySending: (request, response) => approvalJournal.beforeWrite(request, response),
      onPermissionReplyOutcome: observation => { observations.push(observation); approvalJournal.observe(observation); },
    });
    t.after(async () => { client.close(); child.kill(); await closed; });
    await client.initialize();
    await client.openSession({ cwd }, undefined, route);
    const handle = await client.startPrompt([{ type: "text", text: "Synthetic prompt" }]);
    await asked.promise; await live.promise;
    assert.deepEqual(events.map(update => update.update.content.text), ["中文 streaming before decision", "中文 streaming during decision"]);
    assert.equal(store.getApprovalRequest(approvalId).status, "pending");
    if (kimi) assert.equal(store.getApprovalRequest(approvalId).payload.command, "/usr/bin/whois 'example.com'");
    if (action === "cancel") await handle.cancel();
    else {
      if (action === "deny") store.denyApprovalRequest(approvalId, {}, now); else store.approveApprovalRequest(approvalId, {}, now);
      assert.equal(store.getNativeApprovalCorrelation(approvalId).replyStatus, "pending");
      if (action === "expired") time = "2026-09-09T00:05:00.000Z";
      if (action === "stale") store.createWorkUnitAttempt({ workUnitId: key.fence.workUnitId, attemptNumber: 2,
        runtimeInstanceId: "replacement", runnerId: engineId, now });
      decision.resolve(action === "deny" ? "deny" : "approve_once");
    }
    if (action === "expired" || action === "stale") {
      await assert.rejects(handle.completed, { code: "host_commit_failed", outcome: "unknown" });
      client.close(); await closed;
      assert.equal(wire.some(message => message.result?.outcome?.optionId === allowOption), false);
      assert.equal(store.getApprovalRequest(approvalId).status, "approved");
      assert.notEqual(store.getNativeApprovalCorrelation(approvalId).replyStatus, "written");
      return;
    }
    assert.equal((await handle.completed).stopReason, action === "cancel" ? "cancelled" : "end_turn");
    store.finishNativeSubmission({ ...key, outcome: action === "cancel" ? "cancelled" : "completed" }, now);
    assert.equal(events.at(-1).update.content.text, action === "cancel" ? "final cancellation output" : "final decision output");
    assert.equal(permissionSignal.aborted, true);
    decision.resolve("approve_once");
    client.close(); await closed;
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getApprovalRequest(approvalId).status, action === "cancel" ? "cancelled" : action === "deny" ? "denied" : "approved");
      assert.equal(reopened.getNativeApprovalCorrelation(approvalId).replyStatus, action === "cancel" ? "not_written" : "written");
      assert.throws(() => reopened.claimNativeApprovalReply({ approvalId, fence: key.fence }, now), { code: "native_approval_unavailable" });
    } finally { reopened.close(); }
    assert.deepEqual(observations, [{ requestId: "owned-permission", outcome: action === "cancel" ? "not_written" : "written" }]);
    assert.equal(store.getNativeSubmission(key.submissionId).nativeTurnId, undefined);
    assert.equal(store.getNativeSubmission(key.submissionId).nativePromptRequestId, wire.find(message => message.method === "session/prompt").id);
    assert.deepEqual(store.listEvents("run_acp_peer").map(event => event.data.text), events.map(event => event.update.content.text));
    assert.equal(wire.filter(message => message.method === "session/prompt").length, 1);
    if (action === "cancel") assert.equal(wire.some(message => message.result?.outcome?.optionId === allowOption), false);
    assert.deepEqual(wire.find(message => message.method === "session/new").params.mcpServers, []);
  });
}
