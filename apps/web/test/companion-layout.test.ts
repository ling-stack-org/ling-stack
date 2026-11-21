import assert from "node:assert/strict";
import test from "node:test";
import { chooseCompanionCardPlacement, sourceNavigationRequest } from "../src/features/companions/companion-layout.ts";

test("companion cards keep the preferred side while it fits", () => {
  const result = chooseCompanionCardPlacement({
    anchor: { left: 80, top: 120, width: 120, height: 260 },
    card: { width: 240, height: 180 },
    viewport: { left: 0, top: 0, width: 1000, height: 700 },
    preferredSide: "right",
  });
  assert.equal(result.side, "right");
  assert.equal(result.rect.left, 212);
});

test("companion cards choose the opposite side at an edge", () => {
  const result = chooseCompanionCardPlacement({
    anchor: { left: 820, top: 120, width: 140, height: 260 },
    card: { width: 260, height: 200 },
    viewport: { left: 0, top: 0, width: 1000, height: 700 },
    preferredSide: "right",
  });
  assert.equal(result.side, "left");
  assert.ok(result.rect.left >= 12);
});

test("source navigation prefers the canonical conversation item anchor", () => {
  assert.deepEqual(sourceNavigationRequest({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    kind: "user_input",
    id: "request-1",
    sourceItemId: "item-1",
    channelId: "channel-1",
    threadId: "thread-1",
  }), {
    workspace: "/workspace",
    kind: "source",
    channelId: "channel-1",
    threadId: "thread-1",
    sourceItemId: "item-1",
    sourceId: "request-1",
  });
});

test("source navigation forwards the owning approval and run without channel context", () => {
  assert.deepEqual(sourceNavigationRequest({
    workspaceId: "workspace_default",
    cwd: "/workspace",
    kind: "approval",
    id: "approval-1",
    approvalId: "approval-1",
    runId: "run-1",
  }), {
    workspace: "/workspace",
    kind: "source",
    sourceId: "approval-1",
    approvalId: "approval-1",
    runId: "run-1",
  });
});
