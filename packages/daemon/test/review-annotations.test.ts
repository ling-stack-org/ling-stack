import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore } from "@ling-stack/core";
import { projectConversationItemToChannelMessage, type ChannelMessageFileRef } from "@ling-stack/contracts";
import { readOptionalChannelMessageFileRefs } from "../dist/features/channels/schemas.js";
import { renderConversationFileRefsForPrompt } from "../dist/features/conversations/conversation-run-request.js";
import { prepareNormalConversationInput } from "../dist/features/conversations/normal-conversation-input.js";
import { buildLingAgentTurnEnvelope, renderLingAgentTurnEnvelopeForPrompt } from "../dist/features/channels/ling-agent-turn-envelope.js";
import { createDaemonServer } from "../dist/index.js";

const now = "2026-11-17T00:00:00.000Z";
const refs: ChannelMessageFileRef[] = [
  { path: "src/a.ts", source: "composer", line: 8, annotation: { kind: "code", id: "c1", side: "left", startLine: 4, revision: "turn:r1", text: "Handle missing files" } },
  { path: "figure.png", source: "composer", annotation: { kind: "image", id: "i1", source: "artifact", sourceId: "image1", x: .42, y: .61, text: "Move the label" } },
];
test("API parser rejects invalid review anchors and renders structured user feedback", () => {
  assert.deepEqual(readOptionalChannelMessageFileRefs({ refs }, "refs"), refs);
  assert.throws(() => readOptionalChannelMessageFileRefs({ refs: [{ ...refs[0], line: 2 }] }, "refs"), /range/);
  assert.throws(() => readOptionalChannelMessageFileRefs({ refs: Array(13).fill(refs[0]) }, "refs"), /12/);
  const prompt = renderConversationFileRefsForPrompt(refs);
  assert.match(prompt, /Original lines 4-8/); assert.match(prompt, /Handle missing files/); assert.match(prompt, /x: 42%, y: 61%/);
});
test("image data URLs use a bounded media limit while ordinary requests retain their smaller limit", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-review-http-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    maxBodyBytes: 1024 * 1024, maxMediaBodyBytes: 1536 * 1024,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false } });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const payload = (length: number) => JSON.stringify({ providerPresetId: "missing-provider", operation: "image_edit", prompt: "Remove background",
    input: { imageUrl: `data:image/png;base64,${"A".repeat(length)}` } });
  const post = (path: string, body: string) => fetch(`${base}${path}?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const allowed = await post("/media-jobs", payload(1300 * 1024));
  assert.equal(allowed.status, 404); assert.equal((await allowed.json() as { error: string }).error, "provider_not_found");
  const tooLarge = await post("/media-jobs", payload(1600 * 1024));
  assert.equal(tooLarge.status, 400); assert.match(JSON.stringify(await tooLarge.json()), /exceeds 1572864 bytes/);
  const ordinary = await post("/providers", payload(1300 * 1024));
  assert.equal(ordinary.status, 400); assert.match(JSON.stringify(await ordinary.json()), /exceeds 1048576 bytes/);
});
test("normal input, channel envelope and queued intervention retain comments across database reopen", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-review-test-")); let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent", title: "Review", objective: "Feedback" }, now);
  const accepted = prepareNormalConversationInput({ store, thread, message: "Review this", title: "Review", attachmentIds: [], fileRefs: refs, idempotencyKey: "one", now });
  const items = store.listConversationItemsForTurn({ turnId: accepted.turn.id });
  const user = items.find(item => item.kind === "user_message"); assert.ok(user?.kind === "user_message");
  if (user?.kind === "user_message") assert.deepEqual(user.payload.fileRefs, refs);
  store.createRun({ id: "run", cwd, threadId: thread.id, turnId: accepted.turn.id, taskId: "task", providerName: "openai", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const intervention = store.createRunIntervention({ sourceRunId: "run", mode: "queue_followup", instruction: "Follow feedback", idempotencyKey: "queue", messagePayload: { body: "Follow feedback", attachmentIds: [], linkPreviewIds: [], fileRefs: refs.map(ref => ({ ...ref, rootRelation: "unknown", kind: "unknown", materializationStatus: "not_loaded" })) } }, now);
  const channel = store.createChannel({ name: "Review" }, now);
  store.close(); store = createSqliteRunStore(cwd);
  assert.deepEqual(store.getRunIntervention(intervention.id)?.messagePayload?.fileRefs?.map(({ path, source, line, annotation }) => ({ path, source, ...(line ? { line } : {}), annotation })), refs);
  const stored = store.getConversationItem(user!.id)!;
  const message = projectConversationItemToChannelMessage({ ...stored, channelId: channel.id });
  assert.deepEqual(message.fileRefs, refs);
  const envelope = buildLingAgentTurnEnvelope({ store, channel, sourceMessage: message });
  assert.equal(envelope.fileRefs[1]?.materializationStatus, "metadata_only");
  assert.match(renderLingAgentTurnEnvelopeForPrompt(envelope), /Move the label/);
});
