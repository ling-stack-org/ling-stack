import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationSummaryHysteresis,
  conversationSummaryDockHandleWidth,
  conversationSummaryReserveWidth,
  resolveConversationSummaryLayout,
} from "../src/features/workspace/conversation-summary-layout-resolver.ts";
import { channelRightDockResizeHandleWidth } from "../src/features/workspace/layout/channel-workspace-layout.ts";

test("summary and dock geometry share the same resize-handle width", () => {
  assert.equal(conversationSummaryDockHandleWidth, channelRightDockResizeHandleWidth);
});

function resolve(overrides = {}) {
  return resolveConversationSummaryLayout({
    requestedOpen: true,
    containerWidth: 1600,
    dockVisible: true,
    dockWidth: 360,
    wasVisible: false,
    ...overrides,
  });
}

test("summary reserves one shared column when the conversation and dock fit", () => {
  const layout = resolve();
  assert.equal(layout.visible, true);
  assert.equal(layout.reserveWidth, conversationSummaryReserveWidth);
  assert.equal(layout.dockOffset, 360 + 8 + 16);
});

test("summary hides without clearing the requested-open input when space is insufficient", () => {
  const layout = resolve({ containerWidth: 1200 });
  assert.equal(layout.visible, false);
  assert.equal(layout.reserveWidth, 0);
  assert.equal(layout.requiredWidth, 560 + 48 + 296 + 360 + 8);
});

test("closing the dock can restore the same requested summary", () => {
  const constrained = resolve({ containerWidth: 1000 });
  assert.equal(constrained.visible, false);
  const restored = resolve({
    containerWidth: 1000,
    dockVisible: false,
    wasVisible: constrained.visible,
  });
  assert.equal(restored.visible, true);
  assert.equal(restored.dockOffset, 16);
});

test("hysteresis prevents one-pixel resize oscillation at the boundary", () => {
  const requiredWidth = resolve().requiredWidth;
  assert.equal(resolve({ containerWidth: requiredWidth, wasVisible: false }).visible, false);
  assert.equal(resolve({ containerWidth: requiredWidth + conversationSummaryHysteresis, wasVisible: false }).visible, true);
  assert.equal(resolve({ containerWidth: requiredWidth - conversationSummaryHysteresis, wasVisible: true }).visible, true);
  assert.equal(resolve({ containerWidth: requiredWidth - conversationSummaryHysteresis - 1, wasVisible: true }).visible, false);
});

test("closed intent always removes the reserved column", () => {
  assert.deepEqual(resolve({ requestedOpen: false, wasVisible: true }), {
    visible: false,
    reserveWidth: 0,
    dockOffset: 384,
    requiredWidth: 1272,
  });
});
