import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplyPatchError,
  applyPatchPlan,
  parseApplyPatch,
  planApplyPatch,
  renderPatchPreview,
} from "../dist/index.js";

test("apply-patch plans and applies add update and delete operations", async () => {
  const files = new Map([
    ["src/example.txt", "alpha\nbeta\nomega\n"],
    ["old.txt", "remove me\n"],
  ]);
  const patchText = `*** Begin Patch
*** Add File: notes/new.md
+hello
+world
*** Update File: src/example.txt
@@
 alpha
-beta
+bravo
 omega
*** Delete File: old.txt
*** End Patch`;

  const plan = planApplyPatch({
    patchText,
    readFile: (path) => files.get(path),
  });

  assert.deepEqual(plan.touchedPaths, ["notes/new.md", "src/example.txt", "old.txt"]);
  assert.deepEqual(plan.summary, {
    fileCount: 3,
    addCount: 1,
    updateCount: 1,
    deleteCount: 1,
    moveCount: 0,
    addedLines: 3,
    removedLines: 2,
  });
  assert.match(renderPatchPreview(plan), /diff --ling a\/src\/example.txt b\/src\/example.txt/);

  await applyPatchPlan({
    plan,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    deleteFile: (path) => {
      files.delete(path);
    },
  });

  assert.equal(files.get("notes/new.md"), "hello\nworld\n");
  assert.equal(files.get("src/example.txt"), "alpha\nbravo\nomega\n");
  assert.equal(files.has("old.txt"), false);
});

test("apply-patch rejects traversal paths and unknown directives", () => {
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** Add File: ../escape.txt
+bad
*** End Patch`),
    ApplyPatchError,
  );
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** Rename File: a.txt
*** End Patch`),
    ApplyPatchError,
  );
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** Move to: renamed.txt
*** End Patch`),
    /Move operations are not supported in P0/,
  );
  assert.throws(
    () => parseApplyPatch(`*** Begin Patch
*** End Patch`),
    /at least one file operation/,
  );
});

test("apply-patch detects hunk conflicts before approval", () => {
  assert.throws(
    () =>
      planApplyPatch({
        patchText: `*** Begin Patch
*** Update File: src/example.txt
@@
-missing
+new
*** End Patch`,
        readFile: () => "actual\n",
      }),
    /does not match current content/,
  );
});

test("apply-patch rechecks hashes before applying", async () => {
  const files = new Map([["src/example.txt", "old\n"]]);
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/example.txt
@@
-old
+new
*** End Patch`,
    readFile: (path) => files.get(path),
  });
  files.set("src/example.txt", "changed\n");

  let wrote = false;
  await assert.rejects(
    () =>
      applyPatchPlan({
        plan,
        readFile: (path) => files.get(path),
        writeFile: (path, content) => {
          wrote = true;
          files.set(path, content);
        },
        deleteFile: (path) => {
          wrote = true;
          files.delete(path);
        },
      }),
    /changed after preview/,
  );
  assert.equal(wrote, false);
  assert.equal(files.get("src/example.txt"), "changed\n");
});

test("apply-patch renders bounded previews with truncation metadata", () => {
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Add File: long.txt
+${"x".repeat(200)}
*** End Patch`,
    readFile: () => undefined,
  });
  const preview = renderPatchPreview(plan, 80);

  assert.equal(preview.length < 160, true);
  assert.match(preview, /truncated patch preview/);
});
