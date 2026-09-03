import assert from "node:assert/strict";
import test from "node:test";
import { displayableGeneratedMediaArtifacts } from "../src/shared/conversation/generated-media.ts";

const artifacts = [
  { id: "image", type: "image", path: "/image.png", createdAt: "2026-08-12T00:00:00.000Z" },
  { id: "video", type: "video", path: "/video.mp4", createdAt: "2026-08-12T00:00:01.000Z" },
  { id: "log", type: "log", path: "/provider.log", createdAt: "2026-08-12T00:00:02.000Z" },
];

test("generated media preview keeps only artifacts matching the requested operation", () => {
  assert.deepEqual(
    displayableGeneratedMediaArtifacts({ operation: "image_generate", artifacts }).map((item) => item.id),
    ["image"],
  );
  assert.deepEqual(
    displayableGeneratedMediaArtifacts({ operation: "video_generate", artifacts }).map((item) => item.id),
    ["video"],
  );
});
