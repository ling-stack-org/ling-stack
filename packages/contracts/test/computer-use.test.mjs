import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_RUNTIME_STATUSES,
  isComputerUseRuntimeStatus,
  isTerminalComputerUseStatus,
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
