import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileComputerUsePreviewTelemetry,
  serializeComputerUsePreviewTelemetryEvent,
} from "../dist/main/computer-use/telemetry.js";

test("Computer Use telemetry serializer keeps only privacy-safe allowlisted fields", () => {
  const serialized = serializeComputerUsePreviewTelemetryEvent({
    name: "preview_opened",
    firstFrameLatencyMs: 123.6,
    sessionId: "session-private",
    targetLabel: "Private finance window",
    descriptorId: "descriptor-private",
    nativeWindowId: "window-private",
    content: "user-authored text",
  }, new Date("2026-07-16T12:00:00.000Z"));

  assert.deepEqual(serialized, {
    ts: "2026-07-16T12:00:00.000Z",
    event: "preview_opened",
    firstFrameLatencyMs: 124,
  });
  assert.equal(JSON.stringify(serialized).includes("private"), false);
  assert.equal(JSON.stringify(serialized).includes("user-authored"), false);
});

test("Computer Use file telemetry writes local JSONL without leaking source metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-computer-use-telemetry-"));
  const path = join(directory, "nested", "events.jsonl");
  try {
    const telemetry = new FileComputerUsePreviewTelemetry(
      path,
      () => new Date("2026-07-16T12:00:01.000Z"),
    );
    telemetry.record({ name: "preview_renderer_crashed", crashCount: 2 });
    telemetry.record({ name: "preview_stop_acknowledged", accepted: true });

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        ts: "2026-07-16T12:00:01.000Z",
        event: "preview_renderer_crashed",
        crashCount: 2,
      },
      {
        ts: "2026-07-16T12:00:01.000Z",
        event: "preview_stop_acknowledged",
        accepted: true,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Computer Use file telemetry truncates its own bounded diagnostic log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ling-computer-use-telemetry-cap-"));
  const path = join(directory, "events.jsonl");
  try {
    const telemetry = new FileComputerUsePreviewTelemetry(
      path,
      () => new Date("2026-07-16T12:00:02.000Z"),
      1,
    );
    telemetry.record({ name: "preview_source_stalled" });
    telemetry.record({ name: "preview_recovered", recoveryLatencyMs: 250 });

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines, [{
      ts: "2026-07-16T12:00:02.000Z",
      event: "preview_recovered",
      recoveryLatencyMs: 250,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
