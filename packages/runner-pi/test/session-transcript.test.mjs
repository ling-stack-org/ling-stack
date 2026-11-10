import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { frozenPiConversation } from "../dist/session-transcript.js";
import { continuePiSession, isPiHostResumeControl } from "../dist/session-continuation.js";
import { installApprovedToolContinuation, readApprovedToolContinuation } from "../dist/approved-tool-continuation.js";
import { assertCompactionRecoveryModelContext } from "../dist/compaction-recovery.js";
import { capturePreparedPiInput } from "../dist/prepared-input.js";
import { createInitializedPiSession } from "../dist/session-factory.js";
import { PiRunnerAdapter } from "../dist/adapter.js";

const tool = { name: "read", description: "Frozen read", parameters: { type: "object" } };
const authority = { systemPrompt: "Frozen prompt", tools: [tool] };
const user = { role: "user", content: [{ type: "text", text: "accepted" }], timestamp: 0 };

test("conversation-only checkpoints discard only proven frozen SDK authority", () => {
  const head = normalizeContext({ systemPrompt: authority.systemPrompt, tools: [tool], messages: [] }).messages[0];
  const conversation = [head, user, { role: "system", content: "", toolsAdded: [tool], timestamp: 1 }];
  assert.deepEqual(frozenPiConversation(conversation, authority), [user]);
  assert.deepEqual(conversation[2].toolsAdded, [tool], "the canonical delta remains unchanged");
});

test("an omitted leading system cannot become a conversation-only checkpoint", () => {
  assert.throws(() => frozenPiConversation([user], authority), /no leading system authority/);
});

for (const [label, delta] of [
  ["prompt update", { role: "system", content: "new instructions", timestamp: 1 }],
  ["tool replacement", { role: "system", content: "", toolsAdded: [{ ...tool, description: "changed" }], timestamp: 1 }],
  ["tool removal", { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 1 }],
]) {
  test(`a later ${label} cannot be silently removed from a checkpoint`, () => {
    const messages = normalizeContext({ systemPrompt: authority.systemPrompt, tools: [tool], messages: [user] }).messages;
    assert.throws(() => frozenPiConversation([...messages, delta], authority), /changed frozen.*authority/);
  });
}

test("restored compaction first-request validation locks summary content and every retained tail", () => {
  const recovery = { schemaVersion: 1, modelView: [
    { role: "compactionSummary", summary: "sealed progress", timestamp: 0, tokensBefore: 100 }, user,
    { role: "assistant", content: [{ type: "toolCall", id: "saved", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "saved", toolName: "read", content: [{ type: "text", text: "saved result" }], timestamp: 0 },
  ] };
  const context = normalizeContext({ systemPrompt: "Frozen", messages: convertToLlm([
    { ...recovery.modelView[0], timestamp: 42 }, ...structuredClone(recovery.modelView.slice(1)),
  ]) });
  assert.doesNotThrow(() => assertCompactionRecoveryModelContext(recovery, context));
  context.messages.at(-1).content[0].text = "drift";
  assert.throws(() => assertCompactionRecoveryModelContext(recovery, context), /compaction recovery changed/);
  context.messages.at(-1).content[0].text = "saved result";
  context.messages[1].content[0].text += " drift";
  assert.throws(() => assertCompactionRecoveryModelContext(recovery, context), /compaction recovery changed/);
});

for (const [label, replacement] of [
  ["undefined arguments", { args: { absent: undefined } }],
  ["undefined details", { result: { content: [], details: { absent: undefined } } }],
  ["non-finite arguments", { args: { bad: NaN } }],
  ["non-JSON arguments", { args: { date: new Date(0) } }],
]) {
  test(`SDK JsonObject evidence rejects ${label} without lossy normalization`, () => {
    const evidence = { schemaVersion: 1, kind: "approved_tool_result", approvalId: "approval",
      sideEffectFingerprint: "effect", toolCallId: "saved", toolName: "read", args: {}, result: { content: [] }, ...replacement };
    assert.throws(() => readApprovedToolContinuation(evidence), /Invalid approved tool continuation evidence/);
  });
}

test("SDK JsonObject validation never invokes a nested argument accessor", () => {
  let getters = 0;
  const args = { get bad() { getters += 1; return "unsafe"; } };
  assert.throws(() => readApprovedToolContinuation({ schemaVersion: 1, kind: "approved_tool_result", approvalId: "approval",
    sideEffectFingerprint: "effect", toolCallId: "saved", toolName: "read", args, result: { content: [] } }),
  /Invalid approved tool continuation evidence/);
  assert.equal(getters, 0);
});

test("the public resume driver canonically omits its control and preserves the existing transform chain and SDK settlement", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-transcript-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const options = { cwd, tools: [], task: { id: "restore", title: "Restore", prompt: "Finish" },
    provider: { provider: "transcript-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture", reasoning: false } };
  let requests = 0, transforms = 0;
  const contexts = [], settled = [];
  const adapter = new PiRunnerAdapter();
  const session = await createInitializedPiSession(options, runtime => {
    adapter.registerCustomProviderIfNeeded(runtime, options.provider);
    runtime.registerProvider(options.provider.provider, { api: "openai-completions", streamSimple: (model, context, settings) => {
      contexts.push(structuredClone(context.messages));
      return stream(model, context, { ...settings, fetch: async () => {
        requests += 1;
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
      } });
    } });
  });
  t.after(() => session.dispose());
  const prepared = capturePreparedPiInput(session, options);
  installApprovedToolContinuation(session, prepared, options.provider, { schemaVersion: 1,
    kind: "approved_tool_result", approvalId: "approval", sideEffectFingerprint: "effect", toolCallId: "saved",
    toolName: "read", args: {}, result: { content: [{ type: "text", text: "saved" }] } });
  const original = session.agent.transformContext;
  const existingChain = async (messages, signal) => {
    transforms += 1;
    assert.equal(messages.some(isPiHostResumeControl), false);
    return original ? original(messages, signal) : messages;
  };
  session.agent.transformContext = existingChain;
  session.subscribe(event => { if (event.type === "agent_settled") settled.push(event); });
  await continuePiSession(session);
  assert.equal(requests, 1);
  assert.equal(transforms, 1);
  assert.equal(session.agent.transformContext, existingChain);
  assert.deepEqual(settled.map(event => event.aborted), [false]);
  const entries = session.sessionManager.getEntries();
  const control = entries.find(entry => entry.type === "custom_message" && entry.customType === "ling_host_resume_v1");
  assert.ok(control, "append-only SDK journal keeps an auditable internal control entry");
  assert.ok(entries.some(entry => entry.type === "context_edit" && entry.targetId === control.id && entry.replacement === null));
  assert.equal(session.sessionManager.buildSessionProjection().messages.some(isPiHostResumeControl), false);
  assert.equal(session.messages.some(isPiHostResumeControl), false);
  assert.equal(contexts[0].some(message => message.role === "custom"), false);
  assert.equal(getCurrentSystemPrompt(contexts[0]), prepared.systemPrompt);
  assert.deepEqual(getCurrentTools(contexts[0]), prepared.tools);
});
