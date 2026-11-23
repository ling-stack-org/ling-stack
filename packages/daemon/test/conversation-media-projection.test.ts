import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { buildConversationGeneratedMediaProjection } from "../dist/features/media/conversation-projection.js";

test("conversation media projects equal-timestamp artifacts in the job's output order", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-conversation-media-projection-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-08-11T01:00:00.000Z";
  const run = store.createRun({
    id: "run_frame_sequence",
    cwd,
    taskId: "task_frame_sequence",
    providerName: "test",
    providerModel: "test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot: {},
    createdAt: now,
  });
  const job = store.createMediaJob({
    providerPresetId: "test-image-provider",
    operation: "image_generate",
    prompt: "A coastline at changing tides",
  }, now);
  store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "media_job",
    ownerType: "conversation_run",
    ownerId: run.id,
    linkedRunId: run.id,
    linkedMediaJobId: job.id,
    idempotencyKey: "frame-sequence",
    createdByActor: "user",
    request: {
      source: "conversation_media_tool",
      target: { ref: { kind: "provider" }, id: "test-image-provider", displayName: "Test Images" },
    },
    now,
  });
  const first = store.createArtifact({
    id: "artifact_z",
    mediaJobId: job.id,
    type: "image",
    path: "first.png",
    createdAt: now,
  });
  const second = store.createArtifact({
    id: "artifact_a",
    mediaJobId: job.id,
    type: "image",
    path: "second.png",
    createdAt: now,
  });
  const unlisted = store.createArtifact({
    id: "artifact_0",
    mediaJobId: job.id,
    type: "json",
    path: "metadata.json",
    createdAt: now,
  });
  store.updateMediaJobStatus(job.id, { status: "succeeded", artifactIds: [first.id, second.id] }, now);

  const [result] = buildConversationGeneratedMediaProjection({ store, runIds: [run.id] });
  assert.deepEqual(result.artifacts.map((artifact) => artifact.id), [first.id, second.id, unlisted.id]);
});
