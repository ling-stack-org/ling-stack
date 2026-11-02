import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { buildLingAgentTurnEnvelope } from "../dist/features/channels/ling-agent-turn-envelope.js";
import { readOptionalChannelMessageFileRefs } from "../dist/features/channels/schemas.js";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { assertDirectFileRefsWithinWorkspace } from "../dist/features/teammates/direct-workspace.js";

const now = "2026-10-25T06:00:00.000Z";
const body = "请解释在项目子目录运行 node cli.js ../records.csv 时相对路径的含义，不执行命令。";
const inferred = { path: "../records.csv", source: "inferred_text" };

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-inferred-ref-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const channel = store.createChannel({ name: "Path token boundary", boundPath: cwd }, now);
  const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body }, now);
  return { cwd, store, channel, sourceMessage };
}

test("inferred command operands are text, not context-file materialization requests", async t => {
  const f = await fixture(t);
  for (const path of ["../records.csv", "/outside/private.txt", "project/not-created-yet.js"]) {
    const envelope = buildLingAgentTurnEnvelope({ ...f, sourceMessage: { ...f.sourceMessage,
      fileRefs: [{ ...inferred, path }] } });
    assert.equal(envelope.body, body);
    assert.deepEqual(envelope.fileRefs, [], "display token must not stat, load or block a context file");
  }
});

test("inferred path metadata round-trips through request validation and canonical storage", async t => {
  const f = await fixture(t);
  const fileRefs = readOptionalChannelMessageFileRefs({ fileRefs: [inferred] }, "fileRefs");
  assert.deepEqual(fileRefs, [inferred]);
  const message = appendChannelItemFixture(f.store, { channelId: f.channel.id, authorType: "local-user", body, fileRefs }, now);
  const item = f.store.getConversationItem(message.id);
  assert.deepEqual(item.payload.fileRefs, [inferred]);
  assert.deepEqual(message.fileRefs, [inferred]);
  assert.deepEqual(buildLingAgentTurnEnvelope({ ...f, sourceMessage: message }).fileRefs, []);
});

test("normal accepted input preserves inferred origin instead of upgrading it to explicit_text", async t => {
  const f = await fixture(t);
  const thread = f.store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Path token",
    objective: "Preserve origin without authorizing an effect" }, now);
  const prepared = prepareNormalConversationInput({ store: f.store, thread, message: body, title: "Path token",
    attachmentIds: [], fileRefs: [inferred], idempotencyKey: "inferred-origin", now });
  assert.deepEqual(f.store.getConversationItem(prepared.turn.sourceItemId).payload.fileRefs, [inferred]);
});

test("private admission accepts lexical paths without granting explicit file access", async t => {
  const f = await fixture(t);
  const thread = f.store.getOrCreateTeammateDirectThread("teammate_builtin_engineer", now);
  for (const path of ["../records.csv", "/outside/private.txt", "project/not-created-yet.js"]) {
    assert.doesNotThrow(() => assertDirectFileRefsWithinWorkspace({ thread, workspaceCwd: f.cwd,
      fileRefs: [{ path, source: "inferred_text" }] }));
  }
  for (const source of ["composer", "explicit_text", "api", undefined]) {
    assert.throws(() => assertDirectFileRefsWithinWorkspace({ thread, workspaceCwd: f.cwd,
      fileRefs: [{ path: "/outside/private.txt", ...(source ? { source } : {}) }] }), /私聊工作区/);
  }
});

test("a lexical parent path cannot preempt the intent model with an outside-workspace reply", async t => {
  const f = await fixture(t);
  const provider = f.store.createProviderPreset({ kind: "glm", displayName: "Path fixture", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  f.store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Fixture, no network" });
  const channel = { ...f.channel, defaultProviderPresetId: provider.id };
  let calls = 0;
  await selectChannelWorkflowIntent({ store: f.store, channel,
    sourceMessage: { ...f.sourceMessage, fileRefs: [inferred] },
    config: { channels: { intentSelector: true } }, secretResolver: createCompositeSecretResolver({ env: {} }),
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
      calls += 1;
      request.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "reply", reason: "Explain only" }) });
      return { messages: [] };
    } } } }) } });
  assert.equal(calls, 1);
  assert.equal(f.store.listRuns({ channelId: channel.id, limit: 10 }).length, 0);
  assert.equal(f.store.listTasks({ channelId: channel.id, limit: 10 }).length, 0);
});

for (const source of ["composer", "explicit_text", "api"]) {
  test(`explicit ${source} file requests still reject an outside-workspace target`, async t => {
    const f = await fixture(t);
    const envelope = buildLingAgentTurnEnvelope({ ...f, sourceMessage: { ...f.sourceMessage,
      fileRefs: [{ path: "../records.csv", source }] } });
    assert.equal(envelope.fileRefs[0].materializationStatus, "blocked");
    assert.equal(envelope.fileRefs[0].rootRelation, "outside_workspace");
  });
}

test("explicit file: syntax is not suppressed by a same-path inferred token", async t => {
  const f = await fixture(t);
  const envelope = buildLingAgentTurnEnvelope({ ...f, sourceMessage: { ...f.sourceMessage,
    body: "请读取 file:../records.csv", fileRefs: [inferred] } });
  assert.equal(envelope.fileRefs.length, 1);
  assert.equal(envelope.fileRefs[0].source, "explicit_text");
  assert.equal(envelope.fileRefs[0].materializationStatus, "blocked");
});
