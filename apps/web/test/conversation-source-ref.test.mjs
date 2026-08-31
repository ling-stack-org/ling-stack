import assert from "node:assert/strict";
import test from "node:test";
import {
  isTrustedFileSourceRef,
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
