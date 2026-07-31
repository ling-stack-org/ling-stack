import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPngToolResult,
  createFeasibilityEvidence,
  extractStructuredContent,
  hasProbeStatus,
  parseProbeAppEvent,
  readScreenshotCenter,
  selectProbeButton,
  selectProbeWindow,
} from "../scripts/locked-control-darwin-probe-core.mjs";

const nonce = "a".repeat(64);

test("probe app events are closed and nonce-bound", () => {
  assert.deepEqual(
    parseProbeAppEvent(JSON.stringify({ event: "ready", nonce, schemaVersion: 1 }), nonce),
    { event: "ready", nonce, schemaVersion: 1 },
  );
  assert.equal(parseProbeAppEvent(JSON.stringify({
    event: "input_acknowledged",
    nonce,
    schemaVersion: 1,
    sequence: 1,
    password: "forbidden",
  }), nonce), undefined);
  assert.equal(parseProbeAppEvent(JSON.stringify({
    event: "ready",
    nonce: "b".repeat(64),
    schemaVersion: 1,
  }), nonce), undefined);
});

test("target selectors require one exact pid window and exact AX button", () => {
  const windows = {
    structuredContent: {
      windows: [{ pid: 123, window_id: 456, title: "Ling Locked Control Probe" }],
    },
  };
  assert.equal(selectProbeWindow(windows, 123)?.window_id, 456);
  assert.equal(selectProbeWindow(windows, 999), undefined);
  assert.equal(selectProbeWindow({
    structuredContent: {
      windows: [{ window_id: 456, title: "Ling Locked Control Probe" }],
    },
  }, 123), undefined);
  assert.equal(selectProbeWindow({
    structuredContent: {
      windows: [
        ...windows.structuredContent.windows,
        { pid: 123, window_id: 457, title: "Ling Locked Control Probe" },
      ],
    },
  }, 123), undefined);

  const snapshot = {
    structuredContent: {
      elements: [
        { element_index: 7, element_token: "opaque", role: "AXButton", label: "Acknowledge probe" },
        { element_index: 8, role: "AXStaticText", label: "READY 0" },
      ],
    },
  };
  assert.deepEqual(selectProbeButton(snapshot), { elementIndex: 7, elementToken: "opaque" });
  assert.equal(hasProbeStatus(snapshot, "READY 0"), true);
  assert.equal(hasProbeStatus(snapshot, "ACKNOWLEDGED 1"), false);

  assert.equal(selectProbeButton({
    structuredContent: {
      elements: [
        { element_index: 9, role: "AXButton", label: "Acknowledge probe" },
        { element_index: 2, role: "AXButton", label: "Acknowledge probe" },
      ],
    },
  }), undefined);
  assert.deepEqual(selectProbeButton({
    structuredContent: {
      elements: [{ element_index: 4, role: "AXButton", label: "Acknowledged 1" }],
    },
  }), { elementIndex: 4 });
});

test("tool content accepts structured data or a JSON text fallback", () => {
  const expected = { windows: [{ window_id: 1 }] };
  assert.deepEqual(extractStructuredContent({ structuredContent: expected }), expected);
  assert.deepEqual(extractStructuredContent({
    content: [{ type: "text", text: JSON.stringify(expected) }],
  }), expected);
  assert.equal(extractStructuredContent({ content: [{ type: "text", text: "not json" }] }), undefined);
});

test("screenshot proof validates an in-memory PNG without retaining pixels", () => {
  const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(64).fill(0)]);
  assert.doesNotThrow(() => assertPngToolResult({
    content: [{ type: "image", mimeType: "image/png", data: pngHeader.toString("base64") }],
  }));
  assert.throws(() => assertPngToolResult({
    content: [{ type: "image", mimeType: "image/png", data: Buffer.from("not png").toString("base64") }],
  }), /screenshot_not_png/u);
});

test("pixel fallback uses only the exact target window screenshot center", () => {
  assert.deepEqual(readScreenshotCenter({
    structuredContent: { screenshot_width: 920, screenshot_height: 516 },
  }), { x: 460, y: 258 });
  assert.equal(readScreenshotCenter({
    structuredContent: { screenshot_width: 0, screenshot_height: 516 },
  }), undefined);
});

test("feasibility evidence cannot promote without every proof", () => {
  const common = {
    helperSha256: "a".repeat(64),
    providerSha256: "b".repeat(64),
    osVersion: "26.5.2",
    observedAt: "2026-07-31T00:00:00.000Z",
  };
  const positive = createFeasibilityEvidence({
    ...common,
    proofs: {
      sameUserSessionBound: true,
      captureReadyWhileLocked: true,
      inputAcknowledgedWhileLocked: true,
      secureSurfaceExcluded: true,
    },
  });
  assert.equal(positive.result, "feasible_candidate");
  assert.equal(positive.reason, undefined);

  const negative = createFeasibilityEvidence({
    ...common,
    reason: "locked_control_input_unavailable",
    proofs: {
      sameUserSessionBound: true,
      captureReadyWhileLocked: true,
      inputAcknowledgedWhileLocked: false,
      secureSurfaceExcluded: true,
    },
  });
  assert.equal(negative.result, "unsupported");
  assert.throws(() => createFeasibilityEvidence({
    ...common,
    proofs: {
      sameUserSessionBound: true,
      captureReadyWhileLocked: false,
      inputAcknowledgedWhileLocked: false,
      secureSurfaceExcluded: true,
    },
  }), /unsupported_requires_reason/u);
});
