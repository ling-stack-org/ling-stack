import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_PIP_CORNERS,
  MAX_COMPUTER_USE_PIP_COLLISION_OFFSETS,
  chooseComputerUsePreviewBounds,
  clampComputerUsePreviewBounds,
  createComputerUsePreviewCornerCandidates,
  encodeComputerUsePipNormalizedPlacement,
  generateComputerUsePreviewPlacementCandidates,
  restoreComputerUsePipNormalizedPlacement,
  scoreComputerUsePreviewBounds,
} from "../dist/main/computer-use/layout.js";

const DISPLAY_SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

test("four-corner candidates stay inside 1280x800, 1440x900, and 1920x1080 work areas", () => {
  for (const workArea of DISPLAY_SIZES.map((size) => ({ x: 0, y: 0, ...size }))) {
    const candidates = createComputerUsePreviewCornerCandidates({
      workArea,
      size: { width: 400, height: 250 },
    });
    assert.deepEqual(candidates.map((candidate) => candidate.corner), COMPUTER_USE_PIP_CORNERS);
    assert.deepEqual(candidates.map((candidate) => candidate.bounds), [
      { x: 16, y: 16, width: 400, height: 250 },
      { x: workArea.width - 416, y: 16, width: 400, height: 250 },
      { x: 16, y: workArea.height - 266, width: 400, height: 250 },
      { x: workArea.width - 416, y: workArea.height - 266, width: 400, height: 250 },
    ]);
  }
});

test("composer and approval obstacles are blocking and resolve within six offsets", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { width: 400, height: 250 };
  const obstacles = [
    { kind: "composer", x: 300, y: 650, width: 900, height: 250 },
    { kind: "approval", x: 1_000, y: 250, width: 420, height: 300 },
  ];
  const initial = createComputerUsePreviewCornerCandidates({ workArea, size })
    .find((candidate) => candidate.corner === "bottom-right");
  assert.ok(initial);
  assert.ok(scoreComputerUsePreviewBounds({
    bounds: initial.bounds,
    corner: initial.corner,
    obstacles,
  }).blockingCollisionArea > 0);

  const candidates = generateComputerUsePreviewPlacementCandidates({
    workArea,
    size,
    obstacles,
    preferredCorner: "bottom-right",
  });
  const selected = candidates[0];
  assert.equal(selected.corner, "bottom-right");
  assert.equal(selected.score.blockingCollisionArea, 0);
  assert.equal(selected.score.collisionArea, 0);
  assert.ok(selected.offsetIterations > 0);
  assert.ok(selected.offsetIterations <= MAX_COMPUTER_USE_PIP_COLLISION_OFFSETS);
  assert.ok(candidates.every((candidate) => candidate.offsetIterations <= 6));
  assert.deepEqual(chooseComputerUsePreviewBounds({ workArea, size, obstacles }), selected.bounds);
});

test("flat host obstacle kinds keep blocking weight while unknown kinds remain non-blocking", () => {
  const bounds = { x: 900, y: 600, width: 400, height: 250 };
  const composerScore = scoreComputerUsePreviewBounds({
    bounds,
    corner: "bottom-right",
    obstaclePadding: 0,
    obstacles: [{ ...bounds, kind: "composer" }],
  });
  const approvalScore = scoreComputerUsePreviewBounds({
    bounds,
    corner: "bottom-right",
    obstaclePadding: 0,
    obstacles: [{ ...bounds, kind: "approval" }],
  });
  const unknownScore = scoreComputerUsePreviewBounds({
    bounds,
    corner: "bottom-right",
    obstaclePadding: 0,
    obstacles: [{ ...bounds, kind: "unknown" }],
  });

  assert.equal(composerScore.blockingCollisionArea, bounds.width * bounds.height);
  assert.equal(approvalScore.blockingCollisionArea, bounds.width * bounds.height);
  assert.equal(unknownScore.blockingCollisionArea, 0);
  assert.equal(unknownScore.collisionArea, bounds.width * bounds.height);
});

test("work-area clamp keeps oversized and off-screen bounds reachable", () => {
  assert.deepEqual(
    clampComputerUsePreviewBounds(
      { x: -500, y: 1_200, width: 1_600, height: 900 },
      { x: 100, y: 40, width: 1_280, height: 800 },
    ),
    { x: 100, y: 40, width: 1_280, height: 800 },
  );
});

test("normalized placement restores the same relative position after work-area resize", () => {
  const placement = encodeComputerUsePipNormalizedPlacement({
    display: { id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1280, height: 800 } },
    bounds: { x: 660, y: 137.5, width: 400, height: 250 },
  });
  assert.equal(placement.normalizedX, 0.75);
  assert.equal(placement.normalizedY, 0.25);

  const restored = restoreComputerUsePipNormalizedPlacement({
    placement,
    displays: [{ id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  });
  assert.deepEqual(restored, {
    displayId: "primary",
    bounds: { x: 1140, y: 207.5, width: 400, height: 250 },
    usedDisplayFallback: false,
  });
});

test("dual-display restore uses the saved display and falls back when it disconnects", () => {
  const primary = { id: "primary", primary: true, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const secondary = { id: "secondary", workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
  const placement = encodeComputerUsePipNormalizedPlacement({
    display: secondary,
    bounds: { x: 2_580, y: 622.5, width: 400, height: 250 },
  });

  assert.deepEqual(restoreComputerUsePipNormalizedPlacement({ placement, displays: [primary, secondary] }), {
    displayId: "secondary",
    bounds: { x: 2_580, y: 622.5, width: 400, height: 250 },
    usedDisplayFallback: false,
  });

  const disconnected = restoreComputerUsePipNormalizedPlacement({ placement, displays: [primary] });
  assert.deepEqual(disconnected, {
    displayId: "primary",
    bounds: { x: 780, y: 487.5, width: 400, height: 250 },
    usedDisplayFallback: true,
  });
  assert.equal(restoreComputerUsePipNormalizedPlacement({ placement, displays: [] }), undefined);
});
