import assert from "node:assert/strict";
import test from "node:test";

import { validateMediaProjectImageFile } from "../src/features/media-production/media-production-image-files.ts";
import {
  deriveSceneReadiness,
  deriveVideoImageInputIssue,
  shouldShowVideoImageInputs,
} from "../src/features/media-production/media-production-view-models.ts";

const assets = Array.from({ length: 10 }, (_, index) => ({ id: `asset_${index + 1}` }));
const seedance20 = { inputModes: ["text", "first_frame", "reference_image"], maxReferenceImages: 9 };
const seedance15 = { inputModes: ["text", "first_frame"] };

test("text-only scenes remain ready without project images", () => {
  assert.equal(deriveVideoImageInputIssue({ videoImageInputs: [] }, [], seedance20), undefined);
});

test("first-frame and reference inputs follow capability and count boundaries", () => {
  assert.equal(deriveVideoImageInputIssue({ videoImageInputs: [{ assetId: "asset_1", role: "first_frame" }] }, assets, seedance15), undefined);
  assert.equal(deriveVideoImageInputIssue({ videoImageInputs: assets.slice(0, 9).map((asset) => ({ assetId: asset.id, role: "reference_image" })) }, assets, seedance20), undefined);
  assert.deepEqual(
    deriveVideoImageInputIssue({ videoImageInputs: assets.map((asset) => ({ assetId: asset.id, role: "reference_image" })) }, assets, seedance20),
    { key: "This model supports up to {count} reference images.", values: { count: 9 } },
  );
});

test("unsupported roles and missing project assets fail closed", () => {
  assert.deepEqual(
    deriveVideoImageInputIssue({ videoImageInputs: [{ assetId: "asset_1", role: "reference_image" }] }, assets, seedance15),
    { key: "Current model does not support reference images." },
  );
  assert.deepEqual(
    deriveVideoImageInputIssue({ videoImageInputs: [{ assetId: "missing", role: "first_frame" }] }, assets, seedance15),
    { key: "One or more project images are no longer available." },
  );
});

test("persisted image inputs remain visible while the video model is unresolved", () => {
  const scene = { videoImageInputs: [{ assetId: "asset_1", role: "reference_image" }] };
  assert.equal(shouldShowVideoImageInputs(scene, undefined), true);
  assert.deepEqual(
    deriveVideoImageInputIssue(scene, assets, undefined),
    { key: "Current model does not support reference images." },
  );
  assert.equal(shouldShowVideoImageInputs({ videoImageInputs: [] }, undefined), false);
});

test("mixed image purposes fail closed", () => {
  assert.deepEqual(deriveVideoImageInputIssue({ videoImageInputs: [
    { assetId: "asset_1", role: "first_frame" },
    { assetId: "asset_2", role: "reference_image" },
  ] }, assets, seedance20), { key: "Use one image purpose per scene." });
});

test("browser upload preflight rejects unsupported, empty, and oversized files", () => {
  assert.equal(validateMediaProjectImageFile({ type: "image/gif", size: 1024 }), "unsupported_type");
  assert.equal(validateMediaProjectImageFile({ type: "image/png", size: 0 }), "empty_file");
  assert.equal(validateMediaProjectImageFile({ type: "image/webp", size: 25 * 1024 * 1024 + 1 }), "file_too_large");
  assert.equal(validateMediaProjectImageFile({ type: "image/jpeg", size: 25 * 1024 * 1024 }), undefined);
});

test("unresolved image uploads block both scene and project readiness", () => {
  const provider = {
    id: "provider_seedance_20",
    kind: "seedance",
    displayName: "Seedance 2.0",
    providerId: "seedance",
    model: "doubao-seedance-2-0-260128",
    api: "media-job",
    baseUrl: "https://example.invalid/v3",
    apiKeyRef: "env:VIDEO_KEY",
    apiKeyConfigured: true,
    input: ["text", "image"],
    capabilities: ["video_generate"],
    compat: { mediaVendorTransport: { mode: "live" } },
    enabled: true,
  };
  const readiness = deriveSceneReadiness({
    scene: {
      id: "scene_pending_image",
      projectId: "project_i2v",
      sortOrder: 0,
      title: "Pending image",
      prompt: "Move the camera.",
      executionMode: "inherit",
      workflowInputValues: {},
      ratio: "16:9",
      durationSeconds: 5,
      referenceArtifactIds: [],
      videoImageInputs: [],
      canvasPosition: { x: 0, y: 0 },
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    project: {
      id: "project_i2v",
      workspaceId: "workspace_default",
      name: "I2V",
      defaultProviderPresetId: provider.id,
      defaultExecutionMode: "direct",
      canvasViewport: { x: 0, y: 0, zoom: 1 },
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    assets: [],
    providers: [provider],
    sceneRuns: [],
    jobs: [],
    artifactsByJob: {},
    imageInputsPending: true,
  });
  assert.equal(readiness.state, "needs_attention");
  assert.equal(readiness.canRun, false);
  assert.equal(readiness.reasonKey, "Finish or remove pending image uploads before running.");
});
