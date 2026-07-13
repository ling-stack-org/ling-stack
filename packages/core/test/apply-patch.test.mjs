import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplyPatchError,
  applyPatchPlan,
  invertPatchPlan,
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

  await applyPatchPlan({
    plan: invertPatchPlan(plan),
    readFile: (path) => files.get(path),
    writeFile: (path, content) => {
      files.set(path, content);
    },
    deleteFile: (path) => {
      files.delete(path);
    },
  });

  assert.equal(files.has("notes/new.md"), false);
  assert.equal(files.get("src/example.txt"), "alpha\nbeta\nomega\n");
  assert.equal(files.get("old.txt"), "remove me\n");
});

test("inverse patch preserves hash guards", async () => {
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
  await applyPatchPlan({
    plan,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });
  files.set("src/example.txt", "user edit\n");

  await assert.rejects(
    () => applyPatchPlan({
      plan: invertPatchPlan(plan),
      readFile: (path) => files.get(path),
      writeFile: (path, content) => files.set(path, content),
      deleteFile: (path) => files.delete(path),
    }),
    /changed after preview/,
  );
  assert.equal(files.get("src/example.txt"), "user edit\n");
});

test("inverse patch restores deleted files without adding a trailing newline", async () => {
  const files = new Map([["notes.txt", "exact bytes"]]);
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Delete File: notes.txt
*** End Patch`,
    readFile: (path) => files.get(path),
  });

  await applyPatchPlan({
    plan,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });
  await applyPatchPlan({
    plan: invertPatchPlan(plan),
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });

  assert.equal(files.get("notes.txt"), "exact bytes");
});

test("apply and inverse patch preserve CRLF line endings", async () => {
  const original = "alpha\r\nbeta\r\ngamma\r\n";
  const files = new Map([["windows.txt", original]]);
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: windows.txt
@@
-beta
+bravo
*** End Patch`,
    readFile: (path) => files.get(path),
  });

  await applyPatchPlan({
    plan,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });
  assert.equal(files.get("windows.txt"), "alpha\r\nbravo\r\ngamma\r\n");

  await applyPatchPlan({
    plan: invertPatchPlan(plan),
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });
  assert.equal(files.get("windows.txt"), original);
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

test("apply-patch preview adds three context lines around a resolved hunk", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/context.txt
@@ -6,1 +6,1 @@
-line 6
+changed 6
*** End Patch`,
    readFile: () => source,
  });

  const preview = renderPatchPreview(plan, {
    readFile: () => source,
    contextLines: 3,
  });

  assert.match(preview, /@@ -3,7 \+3,7 @@/);
  assert.match(preview, / line 3\n line 4\n line 5\n-line 6\n\+changed 6\n line 7\n line 8\n line 9/);
  assert.doesNotMatch(preview, / line 2\n/);
  assert.doesNotMatch(preview, / line 10\n/);
});

test("apply-patch preview adds three context lines around a pure insertion", () => {
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/context.txt
@@ -6,0 +7,2 @@
+inserted one
+inserted two
*** End Patch`,
    readFile: () => source,
  });

  const preview = renderPatchPreview(plan, {
    readFile: () => source,
    contextLines: 3,
  });

  assert.match(preview, /@@ -4,6 \+4,8 @@/);
  assert.match(preview, / line 4\n line 5\n line 6\n\+inserted one\n\+inserted two\n line 7\n line 8\n line 9/);
});

test("apply-patch preview merges nearby context windows and keeps distant hunks separate", () => {
  const source = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const nearbyPlan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/context.txt
@@ -6,1 +6,1 @@
-line 6
+changed 6
@@ -11,1 +11,1 @@
-line 11
+changed 11
*** End Patch`,
    readFile: () => source,
  });
  const nearbyPreview = renderPatchPreview(nearbyPlan, {
    readFile: () => source,
    contextLines: 3,
  });
  assert.equal((nearbyPreview.match(/^@@/gmu) ?? []).length, 1);
  assert.match(nearbyPreview, /-line 6/);
  assert.match(nearbyPreview, /-line 11/);

  const distantPlan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/context.txt
@@ -6,1 +6,1 @@
-line 6
+changed 6
@@ -22,1 +22,1 @@
-line 22
+changed 22
*** End Patch`,
    readFile: () => source,
  });
  const distantPreview = renderPatchPreview(distantPlan, {
    readFile: () => source,
    contextLines: 3,
  });
  assert.equal((distantPreview.match(/^@@/gmu) ?? []).length, 2);
});

test("apply-patch keeps later insertion coordinates stable after an earlier expansion", async () => {
  const files = new Map([["src/insertions.txt", "alpha\nbeta\ngamma\ndelta\n"]]);
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: src/insertions.txt
@@ -2,1 +2,2 @@
 beta
+beta extra
@@ -4,0 +5,1 @@
+before delta
*** End Patch`,
    readFile: (path) => files.get(path),
  });

  await applyPatchPlan({
    plan,
    readFile: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    deleteFile: (path) => files.delete(path),
  });

  assert.equal(files.get("src/insertions.txt"), "alpha\nbeta\nbeta extra\ngamma\nbefore delta\ndelta\n");
});
