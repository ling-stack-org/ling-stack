import assert from "node:assert/strict";
import test from "node:test";
import { createComputerUsePipPageDeckViewModel } from "../dist/renderer/computer-use-preview/page-deck-view-model.js";

test("page deck view model preserves MRU order and separates resident from View all pages", () => {
  const model = createComputerUsePipPageDeckViewModel(snapshot({
    activePageId: "c",
    requestedPageId: "b",
    availablePageCount: 4,
    pages: [
      page("c", "active"),
      page("a", "inactive"),
      page("b", "activating"),
    ],
    availablePages: [
      available("c", true),
      available("a", true),
      available("b", true),
      available("dismissed", false),
    ],
  }));

  assert.ok(model);
  assert.equal(model.showChrome, true);
  assert.deepEqual(model.residentPages.map((page) => page.pageId), ["c", "a", "b"]);
  assert.deepEqual(model.inactivePages.map((page) => page.pageId), ["a", "b"]);
  assert.equal(model.residentPages[2].requested, true);
  assert.equal(model.availablePages[3].resident, false);
});

test("single page without nonresident entries omits deck chrome", () => {
  const model = createComputerUsePipPageDeckViewModel(snapshot({
    activePageId: "a",
    availablePageCount: 1,
    pages: [page("a", "active")],
    availablePages: [available("a", true)],
  }));
  assert.ok(model);
  assert.equal(model.showChrome, false);
});

function page(pageId, presentationState) {
  return { pageId, targetLabel: `Target ${pageId}`, runtimeStatus: "running", presentationState };
}

function available(pageId, resident) {
  return { pageId, targetLabel: `Target ${pageId}`, runtimeStatus: "running", resident };
}

function snapshot(deck) {
  return {
    sessionId: "c",
    conversationId: "owner",
    locale: "en-US",
    targetLabel: "Target c",
    runtimeStatus: "running",
    sourceStatus: "live",
    sourceKind: "fake",
    sourceRevision: 1,
    sourceGeneration: 1,
    visibilityIntent: "auto",
    frameReady: true,
    aspectRatio: 1.6,
    canStop: true,
    canOpenSettings: false,
    deck,
  };
}
