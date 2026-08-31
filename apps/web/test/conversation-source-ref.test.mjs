import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedFileSourceRef, trustedFileSourceRefForPath } from "../src/shared/conversation/timeline/source-ref.ts";

test("source-ref adapter matches trusted paths without upgrading display-only refs", () => {
  const refs = [
    { kind: "path", id: "model-path", path: "./src/parser.ts" },
    { kind: "file", id: "host-file", path: "src\\parser.ts", hostTarget: "open_file" },
  ];

  assert.equal(isTrustedFileSourceRef(refs[0]), false);
  assert.equal(trustedFileSourceRefForPath(refs, "src/parser.ts")?.id, "host-file");
  assert.equal(trustedFileSourceRefForPath([refs[0]], "src/parser.ts"), undefined);
});

test("source-ref adapter rejects empty and outside matches", () => {
  const refs = [{ kind: "file", id: "host-file", path: "src/parser.ts", hostTarget: "open_file" }];

  assert.equal(trustedFileSourceRefForPath(refs, ""), undefined);
  assert.equal(trustedFileSourceRefForPath(refs, "../src/parser.ts"), undefined);
});
