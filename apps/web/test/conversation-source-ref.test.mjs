import assert from "node:assert/strict";
import test from "node:test";
import {
  isTrustedFileSourceRef,
  isCapabilityActive,
  operationFileSourceRefForPath,
  trustedFileSourceRefForPath,
  upgradeConversationSourceRef,
} from "../src/shared/conversation/timeline/source-ref.ts";

test("source-ref adapter matches trusted paths without upgrading display-only refs", () => {
  const refs = [
    { kind: "path", id: "model-path", path: "./src/parser.ts" },
    { kind: "file", id: "host-file", path: "src\\parser.ts", hostTarget: "open_file", capabilityId: "cap-parser", workspaceId: "workspace-1" },
  ];

  assert.equal(isTrustedFileSourceRef(refs[0]), false);
  assert.equal(trustedFileSourceRefForPath(refs, "src/parser.ts")?.id, "host-file");
  assert.equal(trustedFileSourceRefForPath(refs, "src/parser.ts")?.capabilityId, "cap-parser");
  assert.equal(trustedFileSourceRefForPath([refs[0]], "src/parser.ts"), undefined);
});

test("source-ref adapter rejects empty and outside matches", () => {
  const refs = [{ kind: "file", id: "host-file", path: "src/parser.ts", hostTarget: "open_file" }];

  assert.equal(trustedFileSourceRefForPath(refs, ""), undefined);
  assert.equal(trustedFileSourceRefForPath(refs, "../src/parser.ts"), undefined);
});

test("operation file refs become capability candidates only with atomic lineage", () => {
  const ref = { kind: "file", id: "action-file", path: "./src/parser.ts" };
  const item = {
    id: "action:edit-1",
    kind: "fileChange",
    revision: 3,
    threadSequence: 4,
    partIndex: 1,
    runId: "run-1",
    actionId: "tool:run-1:edit-1",
    attemptId: "attempt-1",
    participantId: "engineer",
    workflowStepId: null,
    sourceRefs: [ref],
    title: "Edited parser.ts",
    files: [],
  };

  assert.equal(operationFileSourceRefForPath([ref], "src\\parser.ts", item)?.id, "action-file");
  assert.equal(operationFileSourceRefForPath([ref], "src/parser.ts", { ...item, runId: undefined }), undefined);
  assert.equal(operationFileSourceRefForPath([ref], "src/parser.ts", { ...item, actionId: undefined }), undefined);
  assert.equal(operationFileSourceRefForPath([ref], "src/parser.ts", { ...item, participantId: undefined }), undefined);
  assert.equal(operationFileSourceRefForPath([ref], "src/other.ts", item), undefined);
});

test("source-ref adapter refuses a capability from another transcript scope", () => {
  const ref = { kind: "path", id: "model-path", path: "src/parser.ts" };
  const capability = {
    kind: "file",
    id: "host-file",
    path: "src/parser.ts",
    hostTarget: "open_file",
    capabilityId: "cap-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
  };

  assert.equal(upgradeConversationSourceRef(ref, capability, {
    workspaceId: "workspace-1",
    threadId: "thread-2",
    runId: "run-1",
  }), undefined);
  assert.equal(upgradeConversationSourceRef(ref, capability, {
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
  })?.capabilityId, "cap-1");
});

test("source-ref adapter rejects expired or daemon-stale capabilities", () => {
  const capability = {
    kind: "file",
    id: "host-file",
    path: "src/parser.ts",
    hostTarget: "open_file",
    capabilityId: "cap-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    daemonEpoch: "epoch-1",
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:05:00.000Z",
  };
  assert.equal(isCapabilityActive(capability, { daemonEpoch: "epoch-1", now: "2026-09-01T00:04:59.000Z" }), true);
  assert.equal(isCapabilityActive(capability, { daemonEpoch: "epoch-1", now: "2026-09-01T00:05:00.000Z" }), false);
  assert.equal(isCapabilityActive(capability, { daemonEpoch: "epoch-2", now: "2026-09-01T00:04:00.000Z" }), false);
  assert.equal(upgradeConversationSourceRef(
    { kind: "path", id: "model-path", path: "src/parser.ts" },
    capability,
    { workspaceId: "workspace-1", threadId: "thread-1", daemonEpoch: "epoch-2", now: "2026-09-01T00:04:00.000Z" },
  ), undefined);
});
