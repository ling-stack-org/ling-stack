import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("media project asset migration and store preserve role-bearing scene inputs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-media-project-assets-"));
  const createdAt = "2026-08-21T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  let projectId = "";
  let assetId = "";
  try {
    const project = store.createMediaProject({ name: "Image to video" }, createdAt);
    projectId = project.id;
    const asset = store.createMediaProjectAsset({
      id: "media_project_asset_fixture",
      projectId,
      fileName: "opening.png",
      contentType: "image/png",
      sizeBytes: 4096,
      width: 1280,
      height: 720,
      checksum: "sha256:fixture",
      path: `media-projects/${projectId}/media_project_asset_fixture.png`,
    }, createdAt);
    assetId = asset.id;
    assert.equal(asset.id, "media_project_asset_fixture");
    assert.deepEqual(store.listMediaProjectAssets(projectId), [asset]);
    assert.deepEqual(store.findMediaProjectAssetByChecksum(projectId, "sha256:fixture"), asset);

    const duplicate = store.createMediaProjectAsset({
      projectId,
      fileName: "duplicate.png",
      contentType: "image/png",
      sizeBytes: 4096,
      width: 1280,
      height: 720,
      checksum: "sha256:fixture",
      path: `media-projects/${projectId}/duplicate.png`,
    }, createdAt);
    assert.equal(duplicate.id, asset.id);
    assert.equal(store.listMediaProjectAssets(projectId).length, 1);

    const scene = store.createMediaScene({
      projectId,
      title: "Opening",
      prompt: "Camera moves forward.",
      videoImageInputs: [{ assetId, role: "reference_image" }],
    }, createdAt);
    assert.deepEqual(scene.videoImageInputs, [{ assetId, role: "reference_image" }]);
    assert.throws(() => store.deleteMediaProjectAsset(assetId), /in use/);

    const otherProject = store.createMediaProject({ name: "Other" }, createdAt);
    assert.throws(() => store.createMediaScene({
      projectId: otherProject.id,
      title: "Cross project",
      prompt: "Must fail.",
      videoImageInputs: [{ assetId, role: "first_frame" }],
    }, createdAt), /not found in scene project/);

    assert.throws(() => store.updateMediaScene(scene.id, {
      videoImageInputs: [
        { assetId, role: "first_frame" },
        { assetId, role: "reference_image" },
      ],
    }, createdAt), /duplicates|one role/);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    assert.deepEqual(store.getMediaScene(store.listMediaScenes(projectId)[0].id)?.videoImageInputs, [
      { assetId, role: "reference_image" },
    ]);
    const database = new DatabaseSync(store.paths.databasePath);
    try {
      assert.equal(
        database.prepare("SELECT name FROM schema_migrations WHERE version = 114").get()?.name,
        "create_media_project_assets",
      );
      assert.ok(database.prepare("SELECT video_image_inputs_json FROM media_scenes LIMIT 1").get());
    } finally {
      database.close();
    }
    const scene = store.listMediaScenes(projectId)[0];
    store.updateMediaScene(scene.id, { videoImageInputs: [] }, createdAt);
    assert.equal(store.deleteMediaProjectAsset(assetId), true);
    assert.equal(store.getMediaProjectAsset(assetId), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("media scene reads fail closed when persisted video image inputs are corrupt", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-corrupt-media-scene-inputs-"));
  const createdAt = "2026-08-21T02:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  let database;
  try {
    const project = store.createMediaProject({ name: "Fail closed" }, createdAt);
    const asset = store.createMediaProjectAsset({
      id: "media_project_asset_primary",
      projectId: project.id,
      fileName: "primary.png",
      contentType: "image/png",
      sizeBytes: 4096,
      width: 1280,
      height: 720,
      checksum: "sha256:primary",
      path: `media-projects/${project.id}/media_project_asset_primary.png`,
    }, createdAt);
    const scene = store.createMediaScene({
      projectId: project.id,
      title: "Corruption boundary",
      prompt: "Keep the persisted image input.",
      videoImageInputs: [{ assetId: asset.id, role: "reference_image" }],
    }, createdAt);
    const validInputs = JSON.stringify(scene.videoImageInputs);
    database = new DatabaseSync(store.paths.databasePath);
    const updateInputs = database.prepare("UPDATE media_scenes SET video_image_inputs_json = ? WHERE id = ?");
    const corruptionCases = [
      { value: "{", error: /Failed to parse JSON from SQLite/ },
      { value: "{}", error: /expected an array/ },
      { value: JSON.stringify([null]), error: /non-empty assetId/ },
      { value: JSON.stringify([{ assetId: "", role: "first_frame" }]), error: /non-empty assetId/ },
      { value: JSON.stringify([{ assetId: asset.id, role: "last_frame" }]), error: /unsupported role/ },
      {
        value: JSON.stringify([
          { assetId: asset.id, role: "reference_image" },
          { assetId: asset.id, role: "reference_image" },
        ]),
        error: /duplicate assetId/,
      },
      {
        value: JSON.stringify([
          { assetId: asset.id, role: "reference_image" },
          { assetId: "media_project_asset_other", role: "first_frame" },
        ]),
        error: /must not be mixed/,
      },
    ];

    for (const corruption of corruptionCases) {
      updateInputs.run(corruption.value, scene.id);
      assert.throws(() => store.getMediaScene(scene.id), corruption.error);
      assert.throws(() => store.listMediaScenes(project.id), corruption.error);
    }

    updateInputs.run(validInputs, scene.id);
    assert.deepEqual(store.getMediaScene(scene.id)?.videoImageInputs, scene.videoImageInputs);
    updateInputs.run("[]", scene.id);
    assert.deepEqual(store.getMediaScene(scene.id)?.videoImageInputs, []);
  } finally {
    database?.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
