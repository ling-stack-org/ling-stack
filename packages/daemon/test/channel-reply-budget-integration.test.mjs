import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { createAiChannelReply } from "../dist/features/channels/ai-replies.js";

test("an oversized channel reply blocks before creating a Run or calling the provider", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-budget-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-27T00:00:00.000Z";
  const provider = store.createProviderPreset({
    kind: "glm", displayName: "Bounded provider", providerId: "bounded-provider",
    model: "bounded-model", api: "google-generative-ai", capabilities: ["chat"],
    input: ["text"], authHeader: false, enabled: true,
    contextWindow: 1800, maxTokens: 512,
  }, now);
  const channel = store.createChannel({ name: "Budget QA", boundPath: cwd,
    defaultProviderPresetId: provider.id, defaultTeammateId: "ling_agent",
    autoReplyMode: "default_teammate" }, now);
  for (let index = 0; index < 6; index += 1) {
    store.createMemoryObject({ id: `budget_memory_${index}`, scopeType: "channel", ownerId: channel.id,
      title: `Please analyze ${"M".repeat(200)} ${index}`,
      body: "large input ".repeat(20) }, now);
  }
  const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id,
    authorType: "local-user", body: "Please analyze: " + "large input ".repeat(2000) }, now);
  let runCalls = 0;
  const reply = await createAiChannelReply({
    startRun: async () => { runCalls++; throw new Error("Run must not start"); },
    store, channel, sourceMessage, providerPresetId: provider.id,
    secretResolver: {}, disableWebEvidence: true, completionMode: "inline",
  });
  assert.equal(runCalls, 0);
  assert.equal(reply.status, "blocked");
  assert.match(reply.body, /context budget/u);
  assert.equal(store.listRuns({ limit: 10 }).length, 0);
});
