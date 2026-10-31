import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { shouldDefaultExpandConversationTimelineSubAgent } from "../src/shared/conversation/timeline/conversation-timeline-sub-agent-disclosure.ts";
import { createConversationViewStore } from "../src/shared/conversation/view-store/conversation-view-store.ts";

const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "silent", server: { middlewareMode: true } });
const { collectConversationTimelineViewRetainKeys, conversationTimelineSubAgentDisclosureKey } = await vite.ssrLoadModule(
  "/src/shared/conversation/timeline/conversation-timeline-view-retain-keys.ts",
);
after(() => vite.close());

const lineage = {
  revision: 1,
  threadSequence: 1,
  partIndex: 0,
  sourceRefs: [],
};

function message(id, status) {
  return {
    ...lineage,
    id,
    kind: "agentMessage",
    ...(status ? { status } : {}),
    markdown: id,
  };
}

function subAgent(lifecycle, childItems = [message("message:done")]) {
  return {
    ...lineage,
    id: "sub-agent:stable",
    kind: "subAgentActivity",
    participantId: "engineer",
    label: "Engineer",
    lifecycle,
    childItems,
  };
}

test("safe completed Agent history defaults collapsed even with 500 child items", () => {
  const item = subAgent(
    "completed",
    Array.from({ length: 500 }, (_, index) => message(`message:${index}`)),
  );

  assert.equal(shouldDefaultExpandConversationTimelineSubAgent(item), false);
  assert.equal(conversationTimelineSubAgentDisclosureKey(item.id), "timeline-sub-agent:sub-agent:stable");
  assert.equal(
    conversationTimelineSubAgentDisclosureKey({ ...item, revision: 99 }.id),
    conversationTimelineSubAgentDisclosureKey(item.id),
  );
});

test("active and attention Agent lifecycles default expanded", () => {
  for (const lifecycle of ["started", "running", "waiting", "blocked", "errored", "interrupted"]) {
    assert.equal(
      shouldDefaultExpandConversationTimelineSubAgent(subAgent(lifecycle)),
      true,
      lifecycle,
    );
  }
});

test("completed Agent remains expanded when a child still needs attention", () => {
  assert.equal(
    shouldDefaultExpandConversationTimelineSubAgent(subAgent("completed", [message("message:running", "running")])),
    true,
  );
  assert.equal(
    shouldDefaultExpandConversationTimelineSubAgent(subAgent("completed", [{
      ...lineage,
      id: "diagnostic:missing-evidence",
      kind: "diagnostic",
      code: "missing_evidence",
      status: "blocked",
      title: "Activity unavailable",
      summary: "Evidence is missing.",
    }])),
    true,
  );
});

test("manual Agent disclosure survives retained SSE revision reconciliation", () => {
  const item = subAgent("completed");
  const blockId = conversationTimelineSubAgentDisclosureKey(item.id);
  const store = createConversationViewStore("channel:engineering");
  store.ensureDisclosure({
    id: blockId,
    kind: "block",
    revisionKey: "1",
    defaultExpanded: false,
    preserveTouchedStateOnRevision: true,
  });
  store.setDisclosureExpanded("block", blockId, true);

  const refreshedItem = { ...item, revision: 2 };
  store.reconcileRetainedKeys(collectConversationTimelineViewRetainKeys([refreshedItem]));
  store.ensureDisclosure({
    id: blockId,
    kind: "block",
    revisionKey: "2",
    defaultExpanded: false,
    preserveTouchedStateOnRevision: true,
  });

  assert.deepEqual(store.getSnapshot().blockDisclosureById.get(blockId), {
    expanded: true,
    revisionKey: "2",
    touched: true,
  });
});
