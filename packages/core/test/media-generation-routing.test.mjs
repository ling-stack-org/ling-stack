import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  createSqliteRunStore,
  resolveMediaGenerationTarget,
} from "../dist/index.js";

const providerImage = target({
  id: "provider:image",
  ref: { kind: "provider", providerPresetId: "image" },
  generationKind: "image",
  displayName: "Studio Image",
});
const workflowImage = target({
  id: "workflow:poster",
  ref: { kind: "workflow", workflowDefinitionId: "poster" },
  generationKind: "image",
  displayName: "Poster Flow",
});

test("media target resolver follows explicit, default, unique, and selection-required order", () => {
  assert.equal(resolveMediaGenerationTarget({
    generationKind: "image",
    requestedTarget: "Poster Flow",
    defaultTarget: providerImage.ref,
    targets: [providerImage, workflowImage],
  }).target.id, workflowImage.id);

  assert.equal(resolveMediaGenerationTarget({
    generationKind: "image",
    defaultTarget: providerImage.ref,
    targets: [providerImage, workflowImage],
  }).target.id, providerImage.id);

  assert.equal(resolveMediaGenerationTarget({
    generationKind: "image",
    targets: [providerImage],
  }).source, "only_runnable");

  const selection = resolveMediaGenerationTarget({
    generationKind: "image",
    targets: [providerImage, workflowImage],
  });
  assert.equal(selection.ok, false);
  assert.equal(selection.code, "target_selection_required");
  assert.deepEqual(selection.candidates.map((item) => item.displayName), ["Studio Image", "Poster Flow"]);
});

test("media target resolver never falls back from explicit or invalid default targets", () => {
  const disabled = target({
    id: "provider:disabled",
    ref: { kind: "provider", providerPresetId: "disabled" },
    generationKind: "image",
    displayName: "Disabled Image",
    runnable: false,
    unavailableReason: "Provider is disabled.",
  });
  const explicit = resolveMediaGenerationTarget({
    generationKind: "image",
    requestedTarget: "Disabled Image",
    defaultTarget: providerImage.ref,
    targets: [disabled, providerImage],
  });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.code, "generation_target_not_runnable");

  const invalidDefault = resolveMediaGenerationTarget({
    generationKind: "image",
    defaultTarget: disabled.ref,
    targets: [disabled, providerImage],
  });
  assert.equal(invalidDefault.ok, false);
  assert.equal(invalidDefault.code, "generation_target_not_runnable");
});

test("workspace media defaults persist and conversation tool creation is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-media-generation-routing-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-08-11T00:00:00.000Z";
  try {
    const settings = store.updateWorkspaceSettings({
      mediaGenerationDefaults: {
        image: providerImage.ref,
        video: { kind: "workflow", workflowDefinitionId: "video-flow" },
      },
    }, now);
    assert.deepEqual(settings.mediaGenerationDefaults, {
      image: providerImage.ref,
      video: { kind: "workflow", workflowDefinitionId: "video-flow" },
    });

    store.createRun({
      id: "run_media_tool",
      cwd,
      taskId: "message_media_tool",
      providerName: "chat",
      providerModel: "chat-model",
      taskSnapshot: { id: "message_media_tool", title: "Generate", prompt: "Draw" },
      providerSnapshot: { provider: "chat", model: "chat-model" },
      requestSnapshot: { cwd },
      createdAt: now,
    });
    const input = {
      runId: "run_media_tool",
      linkedMessageId: "assistant_media_tool",
      idempotencyKey: "media_tool:run_media_tool:call_1",
      toolCallId: "call_1",
      target: {
        id: providerImage.id,
        ref: providerImage.ref,
        generationKind: "image",
        displayName: providerImage.displayName,
      },
      mediaJob: {
        providerPresetId: "image",
        operation: "image_generate",
        prompt: "Draw a skyline",
      },
    };
    const first = store.createOrReuseConversationMediaJob(input, now);
    const second = store.createOrReuseConversationMediaJob(input, "2026-08-11T00:00:01.000Z");
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.mediaJob.id, second.mediaJob.id);
    assert.equal(first.workUnit.id, second.workUnit.id);
    assert.equal(first.workUnit.linkedRunId, "run_media_tool");
    assert.equal(first.workUnit.linkedMediaJobId, first.mediaJob.id);
    assert.equal(store.listMediaJobs().length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function target(input) {
  return {
    aliases: [],
    runnable: true,
    ...input,
  };
}
