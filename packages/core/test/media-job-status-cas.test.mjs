import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const createdAt = "2026-10-15T00:00:00.000Z";
const updatedAt = "2026-10-15T00:00:01.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-status-cas-"));
  const stores = [];
  t.after(async () => {
    try { for (const store of stores) store.close(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  const store = open();
  const job = store.createMediaJob({ providerPresetId: "owned-no-provider-call",
    operation: "video_generate", prompt: "SQLite-only CAS regression", input: {} }, createdAt);
  return { store, job, open };
}

test("Media status CAS preserves the existing unconditional update contract", async t => {
  const { store, job } = await fixture(t);
  const failed = store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: "owned failure" }, updatedAt);
  assert.equal(failed.status, "failed");
  const queued = store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, updatedAt);
  assert.equal(queued.status, "queued");
  assert.equal(queued.errorMessage, undefined);
});

test("Media status CAS accepts a current active state and preserves omitted fields", async t => {
  const { store, job } = await fixture(t);
  store.updateMediaJobStatus(job.id, { status: "running", artifactIds: ["owned-existing"], errorMessage: "existing note" }, createdAt);
  const cancelled = store.updateMediaJobStatus(job.id, {
    status: "cancelled", expectedStatuses: ["queued", "running", "waiting_for_approval"],
  }, updatedAt);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.artifactIds, ["owned-existing"]);
  assert.equal(cancelled.errorMessage, "existing note");
  assert.equal(cancelled.updatedAt, updatedAt);
});

for (const winner of ["succeeded", "cancelled"]) {
  test(`Media status CAS cannot replace ${winner} from a stale second Store snapshot`, async t => {
    const { store, job, open } = await fixture(t);
    const second = open();
    assert.equal(second.getMediaJob(job.id).status, "queued");
    const active = ["queued", "running", "waiting_for_approval"];
    const won = store.updateMediaJobStatus(job.id, { status: winner, expectedStatuses: active,
      artifactIds: winner === "succeeded" ? ["owned-result"] : [], errorMessage: null }, updatedAt);
    assert.equal(won.status, winner);
    const before = second.getMediaJob(job.id);
    assert.equal(second.updateMediaJobStatus(job.id, { status: winner === "succeeded" ? "cancelled" : "failed",
      expectedStatuses: active, artifactIds: ["must-not-publish"], errorMessage: "must-not-publish" },
    "2026-10-15T00:00:02.000Z"), undefined);
    assert.deepEqual(store.getMediaJob(job.id), before, "failed comparison cannot update metadata or timestamps");
  });
}

test("Media status CAS rejects empty or invalid comparisons before mutation", async t => {
  const { store, job } = await fixture(t);
  for (const expectedStatuses of [[], ["not-a-media-status"], ["queued", "not-a-media-status"]]) {
    assert.throws(() => store.updateMediaJobStatus(job.id, { status: "cancelled", expectedStatuses }, updatedAt),
      /valid non-empty expected statuses/);
    assert.deepEqual(store.getMediaJob(job.id), job);
  }
});

test("Media status CAS returns missing without creating a job", async t => {
  const { store } = await fixture(t);
  assert.equal(store.updateMediaJobStatus("owned-missing-job", { status: "cancelled", expectedStatuses: ["queued"] }, updatedAt), undefined);
  assert.equal(store.getMediaJob("owned-missing-job"), undefined);
});
