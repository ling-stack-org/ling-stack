import assert from "node:assert/strict";
import test from "node:test";
import {
  parseControlPlaneReplayWindowMessage,
  parseControlPlaneRpcSubscribeMessage,
} from "../src/lib/control-plane.ts";

test("parses complete and snapshot-required replay windows", () => {
  assert.deepEqual(parseControlPlaneReplayWindowMessage(JSON.stringify(windowFixture("complete"))), windowFixture("complete"));
  assert.deepEqual(parseControlPlaneReplayWindowMessage(JSON.stringify({
    ...windowFixture("snapshot_required"),
    reason: "retention_gap",
  })), {
    ...windowFixture("snapshot_required"),
    reason: "retention_gap",
  });
  assert.equal(parseControlPlaneReplayWindowMessage(JSON.stringify({
    ...windowFixture("snapshot_required"),
    reason: "unknown",
  })), undefined);
});

test("parses RPC complete subscribe only with an id and snapshot-required without one", () => {
  assert.deepEqual(parseControlPlaneRpcSubscribeMessage(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      disposition: "complete",
      subscriptionId: "cp_1",
      window: windowFixture("complete"),
    },
  }), 2), {
    error: false,
    result: {
      disposition: "complete",
      subscriptionId: "cp_1",
      window: windowFixture("complete"),
    },
  });
  assert.deepEqual(parseControlPlaneRpcSubscribeMessage(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      disposition: "snapshot_required",
      window: { ...windowFixture("snapshot_required"), reason: "window_exceeded" },
    },
  }), 2)?.result, {
    disposition: "snapshot_required",
    window: { ...windowFixture("snapshot_required"), reason: "window_exceeded" },
  });
  assert.equal(parseControlPlaneRpcSubscribeMessage(JSON.stringify({ id: 3, result: {} }), 2), undefined);
  assert.equal(parseControlPlaneRpcSubscribeMessage(JSON.stringify({
    id: 2,
    result: { disposition: "complete", window: windowFixture("complete") },
  }), 2)?.error, true);
});

function windowFixture(disposition) {
  return {
    disposition,
    requestedAfterSeq: 5,
    replayFloorSeq: 0,
    upperBoundSeq: 8,
    nextAfterSeq: 8,
  };
}
