import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPUTER_USE_PIP_MAX_RESIDENT_PAGES,
  cancelComputerUsePipDeckPageSwitch,
  commitComputerUsePipDeckPage,
  createComputerUsePipDeckState,
  dismissComputerUsePipDeckPage,
  reconcileComputerUsePipDeck,
  requestComputerUsePipDeckPage,
  selectComputerUsePipDeckProjections,
} from "../dist/main/computer-use/deck.js";
import { FAKE_COMPUTER_USE_PROJECTION } from "../dist/main/computer-use/fake-projection-client.js";

const SCOPE = {
  workspaceId: "workspace-1",
  surfaceKind: "normal_conversation",
  ownerId: FAKE_COMPUTER_USE_PROJECTION.conversationId,
};

test("deck selector admits only active preview projections in the exact owner", () => {
  const selected = selectComputerUsePipDeckProjections({
    scope: SCOPE,
    projections: [
      projection("older", 1),
      projection("latest", 3),
      projection("terminal", 4, { status: "succeeded" }),
      projection("summary-only", 5, { preview: undefined }),
      projection("other-owner", 6, { conversationId: "other-owner" }),
    ],
  });

  assert.deepEqual(selected.map((item) => item.sessionId), ["latest", "older"]);
});

test("deck reconcile creates at most five resident pages and keeps all eligible ids available", () => {
  const projections = Array.from({ length: 7 }, (_, index) => projection(`session-${index + 1}`, index + 1));
  const state = reconcileComputerUsePipDeck({ scope: SCOPE, projections, nowMs: 100 });

  assert.equal(state.availablePageIds.length, 7);
  assert.equal(state.pages.length, COMPUTER_USE_PIP_MAX_RESIDENT_PAGES);
  assert.equal(state.activePageId, "session-7");
  assert.deepEqual(state.pages.map((page) => page.pageId), [
    "session-7",
    "session-6",
    "session-5",
    "session-4",
    "session-3",
  ]);
  assert.equal(state.pages[0]?.presentationState, "active");
});

test("descriptor revisions update one session page instead of creating a duplicate", () => {
  const initial = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: [projection("session-1", 1)],
    nowMs: 100,
  });
  const updated = reconcileComputerUsePipDeck({
    state: initial,
    scope: SCOPE,
    projections: [projection("session-1", 2, {
      preview: { ...FAKE_COMPUTER_USE_PROJECTION.preview, descriptorId: "replacement", revision: 2 },
    })],
    nowMs: 200,
  });

  assert.deepEqual(updated.pages.map((page) => page.pageId), ["session-1"]);
  assert.equal(updated.activePageId, "session-1");
});

test("scope replacement clears resident, dismissed, requested, and MRU state", () => {
  let state = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: [projection("session-1", 1), projection("session-2", 2)],
    nowMs: 100,
  });
  state = dismissComputerUsePipDeckPage(state, "session-1", 110);
  const request = requestComputerUsePipDeckPage(state, "session-1", 120);
  assert.ok(request);

  const otherScope = { ...SCOPE, surfaceKind: "teammate_direct", ownerId: "other-owner" };
  const replaced = reconcileComputerUsePipDeck({
    state: request.state,
    scope: otherScope,
    projections: [projection("other-session", 3, { conversationId: "other-owner" })],
    nowMs: 200,
  });

  assert.deepEqual(replaced.availablePageIds, ["other-session"]);
  assert.deepEqual(replaced.dismissedPageIds, []);
  assert.equal(replaced.requestedPageId, undefined);
  assert.equal(replaced.switchGeneration, 0);
});

test("rapid page requests commit only the latest switch generation", () => {
  const state = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: [projection("a", 3), projection("b", 2), projection("c", 1)],
    nowMs: 100,
  });
  const requestB = requestComputerUsePipDeckPage(state, "b", 110);
  assert.ok(requestB);
  const requestC = requestComputerUsePipDeckPage(requestB.state, "c", 120);
  assert.ok(requestC);

  const staleCommit = commitComputerUsePipDeckPage(requestC.state, {
    pageId: "b",
    generation: requestB.generation,
    nowMs: 130,
  });
  assert.equal(staleCommit.activePageId, "a");
  assert.equal(staleCommit.requestedPageId, "c");

  const committed = commitComputerUsePipDeckPage(staleCommit, {
    pageId: "c",
    generation: requestC.generation,
    nowMs: 140,
  });
  assert.equal(committed.activePageId, "c");
  assert.equal(committed.requestedPageId, undefined);
  assert.deepEqual(committed.pages.map((page) => page.pageId), ["c", "a", "b"]);
});

test("switch cancellation preserves the active page and rejects stale cancellation", () => {
  const state = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: [projection("a", 2), projection("b", 1)],
    nowMs: 100,
  });
  const request = requestComputerUsePipDeckPage(state, "b", 110);
  assert.ok(request);

  assert.equal(cancelComputerUsePipDeckPageSwitch(request.state, {
    generation: request.generation - 1,
    nowMs: 120,
  }), request.state);
  const cancelled = cancelComputerUsePipDeckPageSwitch(request.state, {
    generation: request.generation,
    nowMs: 130,
  });
  assert.equal(cancelled.activePageId, "a");
  assert.equal(cancelled.requestedPageId, undefined);
  assert.equal(cancelled.pages.find((page) => page.pageId === "a")?.presentationState, "active");
  assert.deepEqual(cancelled.pages.map((page) => page.pageId), ["a", "b"]);
});

test("requesting a resident page does not update MRU before first-frame commit", () => {
  const state = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: [projection("a", 3), projection("b", 2), projection("c", 1)],
    nowMs: 100,
  });
  const request = requestComputerUsePipDeckPage(state, "c", 110);
  assert.ok(request);

  assert.deepEqual(request.state.pages.map((page) => page.pageId), ["a", "b", "c"]);
  assert.equal(request.state.requestedPageId, "c");

  const cancelled = cancelComputerUsePipDeckPageSwitch(request.state, {
    generation: request.generation,
    nowMs: 120,
  });
  assert.deepEqual(cancelled.pages.map((page) => page.pageId), ["a", "b", "c"]);
});

test("opening a sixth resident page evicts only the inactive LRU page", () => {
  let state = reconcileComputerUsePipDeck({
    scope: SCOPE,
    projections: Array.from({ length: 6 }, (_, index) => projection(`session-${index + 1}`, index + 1)),
    nowMs: 100,
  });
  const requestOlder = requestComputerUsePipDeckPage(state, "session-3", 110);
  assert.ok(requestOlder);
  state = commitComputerUsePipDeckPage(requestOlder.state, {
    pageId: "session-3",
    generation: requestOlder.generation,
    nowMs: 200,
  });

  const requestSixth = requestComputerUsePipDeckPage(state, "session-1", 210);
  assert.ok(requestSixth);
  assert.equal(requestSixth.evictedPageId, "session-2");
  assert.equal(requestSixth.state.pages.some((page) => page.pageId === "session-3"), true);
  assert.equal(requestSixth.state.pages.some((page) => page.pageId === "session-1"), true);
  assert.equal(requestSixth.state.pages.length, 5);
});

test("dismissal survives projection refresh and explicit View all reopen clears it", () => {
  const projections = [projection("a", 2), projection("b", 1)];
  let state = reconcileComputerUsePipDeck({ scope: SCOPE, projections, nowMs: 100 });
  state = dismissComputerUsePipDeckPage(state, "b", 110);
  assert.deepEqual(state.dismissedPageIds, ["b"]);

  state = reconcileComputerUsePipDeck({ state, scope: SCOPE, projections, nowMs: 120 });
  assert.equal(state.pages.some((page) => page.pageId === "b"), false);

  const reopened = requestComputerUsePipDeckPage(state, "b", 130);
  assert.ok(reopened);
  assert.deepEqual(reopened.state.dismissedPageIds, []);
  assert.equal(reopened.state.pages.some((page) => page.pageId === "b"), true);
});

test("terminal and removed pages prune dismissal and fail over active selection", () => {
  const projections = [projection("a", 3), projection("b", 2), projection("c", 1)];
  let state = reconcileComputerUsePipDeck({ scope: SCOPE, projections, nowMs: 100 });
  state = dismissComputerUsePipDeckPage(state, "b", 110);
  state = dismissComputerUsePipDeckPage(state, "a", 120);
  assert.equal(state.activePageId, "c");

  const reconciled = reconcileComputerUsePipDeck({
    state,
    scope: SCOPE,
    projections: [projection("a", 4, { status: "failed" }), projection("c", 1)],
    nowMs: 130,
  });
  assert.deepEqual(reconciled.dismissedPageIds, []);
  assert.equal(reconciled.activePageId, "c");
  assert.deepEqual(reconciled.availablePageIds, ["c"]);
});

function projection(sessionId, order, overrides = {}) {
  return {
    ...FAKE_COMPUTER_USE_PROJECTION,
    ...overrides,
    sessionId,
    updatedAt: `2026-07-18T00:00:${String(order).padStart(2, "0")}.000Z`,
  };
}
