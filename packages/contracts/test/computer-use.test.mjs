import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_RUNTIME_STATUSES,
  isComputerUseRuntimeStatus,
  isTerminalComputerUseStatus,
  parseComputerUsePreviewEvent,
  parseComputerUsePreviewEventsResponse,
  parseComputerUsePreviewProjection,
  parseComputerUsePreviewSnapshotResponse,
  parseStopComputerUseResponse,
} from "../dist/index.js";

test("Computer Use statuses round-trip through JSON", () => {
  for (const status of COMPUTER_USE_RUNTIME_STATUSES) {
    const projection = {
      sessionId: `session-${status}`,
      conversationId: "conversation-1",
      turnId: "turn-1",
      runId: "run-1",
      workUnitId: "work-unit-1",
      status,
      target: {
        kind: "window",
        displayName: "Example browser",
        applicationId: "com.example.browser",
      },
      preview: {
        descriptorId: "opaque-preview-descriptor",
        revision: 3,
        aspectRatio: 1.6,
        cursorAvailable: true,
      },
      approvalRequired: status === "waiting_for_approval"
        ? { approvalId: "approval-1", summary: "Confirm the next action" }
        : undefined,
      failure: status === "failed"
        ? { code: "source_ended", message: "The preview source ended", recoverable: true }
        : undefined,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:01:00.000Z",
      terminalAt: isTerminalComputerUseStatus(status) ? "2026-07-15T00:01:00.000Z" : undefined,
    };

    const roundTripped = JSON.parse(JSON.stringify(projection));
    assert.equal(roundTripped.status, status);
    assert.equal(roundTripped.preview.descriptorId, "opaque-preview-descriptor");
    assert.equal(isComputerUseRuntimeStatus(roundTripped.status), true);
  }
});

test("Computer Use status guard rejects arbitrary strings", () => {
  assert.equal(isComputerUseRuntimeStatus("thinking"), false);
  assert.equal(isComputerUseRuntimeStatus(undefined), false);
});

test("only terminal statuses are classified as terminal", () => {
  assert.deepEqual(
    COMPUTER_USE_RUNTIME_STATUSES.filter(isTerminalComputerUseStatus),
    ["succeeded", "failed", "cancelled"],
  );
});

test("Computer Use runtime parsers copy only validated projection fields", () => {
  const parsed = parseComputerUsePreviewProjection({
    ...validProjection(),
    privateNativeWindowHandle: "must-not-cross-the-boundary",
    preview: {
      ...validProjection().preview,
      privateCaptureToken: "must-not-cross-the-boundary",
    },
  });

  assert.deepEqual(parsed, validProjection());
  assert.equal("privateNativeWindowHandle" in parsed, false);
  assert.equal("privateCaptureToken" in parsed.preview, false);
});

test("Computer Use runtime parsers reject malformed or cross-boundary-inconsistent payloads", () => {
  assert.equal(parseComputerUsePreviewProjection({ ...validProjection(), status: "thinking" }), undefined);
  assert.equal(parseComputerUsePreviewProjection({ ...validProjection(), updatedAt: "not-a-timestamp" }), undefined);
  assert.equal(parseComputerUsePreviewProjection({
    ...validProjection(),
    preview: { ...validProjection().preview, revision: -1 },
  }), undefined);
  assert.equal(parseComputerUsePreviewProjection({
    ...validProjection(),
    preview: {
      ...validProjection().preview,
      revision: Number.MAX_SAFE_INTEGER + 1,
    },
  }), undefined);

  assert.equal(parseComputerUsePreviewEvent({
    seq: 1,
    kind: "upsert",
    sessionId: "other-session",
    projection: validProjection(),
    occurredAt: "2026-07-15T00:01:00.000Z",
  }), undefined);
  assert.equal(parseComputerUsePreviewEvent({
    seq: 1,
    kind: "remove",
    sessionId: "session-1",
    projection: validProjection(),
    occurredAt: "2026-07-15T00:01:00.000Z",
  }), undefined);
  const validEvent = {
    seq: 2,
    kind: "upsert",
    sessionId: "session-1",
    projection: validProjection(),
    occurredAt: "2026-07-15T00:01:00.000Z",
  };
  assert.equal(parseComputerUsePreviewEvent({
    ...validEvent,
    seq: Number.MAX_SAFE_INTEGER + 1,
  }), undefined);
  assert.equal(parseComputerUsePreviewEventsResponse({
    cwd: "/workspace",
    afterSeq: 0,
    latestSeq: 3,
    events: [validEvent, { ...validEvent, seq: 2 }],
  }, "/workspace"), undefined);
  assert.equal(parseComputerUsePreviewEventsResponse({
    cwd: "/workspace",
    afterSeq: 0,
    latestSeq: 3,
    events: [{ ...validEvent, seq: 3 }, { ...validEvent, seq: 2 }],
  }, "/workspace"), undefined);

  assert.equal(parseComputerUsePreviewSnapshotResponse({
    cwd: "/other-workspace",
    projections: [validProjection()],
    latestSeq: 1,
  }, "/workspace"), undefined);
  assert.equal(parseComputerUsePreviewSnapshotResponse({
    cwd: "/workspace",
    projections: [validProjection()],
    latestSeq: Number.MAX_SAFE_INTEGER + 1,
  }, "/workspace"), undefined);
  assert.equal(parseStopComputerUseResponse({
    sessionId: "session-1",
    accepted: true,
    acknowledged: true,
    auditId: "audit-1",
    projection: { ...validProjection(), sessionId: "other-session" },
  }, "session-1"), undefined);
  assert.equal(parseStopComputerUseResponse({
    sessionId: "session-1",
    accepted: false,
    acknowledged: true,
    auditId: "audit-1",
    projection: validProjection(),
  }, "session-1"), undefined);
});

function validProjection() {
  return {
    sessionId: "session-1",
    conversationId: "conversation-1",
    runId: "run-1",
    status: "running",
    target: {
      kind: "window",
      displayName: "Example browser",
      applicationId: "com.example.browser",
    },
    preview: {
      descriptorId: "opaque-preview-descriptor",
      revision: 3,
      aspectRatio: 1.6,
      cursorAvailable: true,
    },
    startedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:01:00.000Z",
  };
}
