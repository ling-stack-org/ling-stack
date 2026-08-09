import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPatchActionDraft } from "../dist/features/runs/patch-actions.js";

test("patch action draft stores three lines of stable source context", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-patch-preview-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"), { recursive: true });
  const source = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  await writeFile(join(cwd, "src/context.txt"), source, "utf8");
  const patchText = `*** Begin Patch
*** Update File: src/context.txt
@@ -6,1 +6,1 @@
-line 6
+changed 6
*** End Patch`;

  const draft = createPatchActionDraft({
    request: {
      toolName: "edit",
      cwd,
      input: { patchText },
    },
    patchText,
    allowedWritePaths: ["."],
  });

  assert.match(draft.diffPreview, /@@ -3,7 \+3,7 @@/);
  assert.match(draft.diffPreview, / line 3\n line 4\n line 5\n-line 6\n\+changed 6\n line 7\n line 8\n line 9/);
  assert.equal(draft.payload.type, "file_edit");
  assert.equal(draft.payload.diffPreview, draft.diffPreview);
});

test("patch action accepts a nonexistent path reached through an allowed symlink alias", async (t) => {
  const container = await realpath(await mkdtemp(join(tmpdir(), "ling-patch-alias-")));
  const workspace = join(container, "workspace");
  const alias = join(container, "workspace-alias");
  t.after(async () => rm(container, { recursive: true, force: true }));
  await mkdir(workspace);
  await symlink(workspace, alias, "dir");

  const patchText = `*** Begin Patch
*** Add File: nested/new.txt
+created through alias
*** End Patch`;

  const draft = createPatchActionDraft({
    request: {
      toolName: "write",
      cwd: alias,
      input: { patchText },
    },
    patchText,
    allowedWritePaths: [workspace],
  });

  assert.deepEqual(draft.plan.touchedPaths, ["nested/new.txt"]);
});

test("patch action rejects a nonexistent path beneath a symlink escaping the workspace", async (t) => {
  const container = await realpath(await mkdtemp(join(tmpdir(), "ling-patch-escape-")));
  const workspace = join(container, "workspace");
  const outside = join(container, "outside");
  t.after(async () => rm(container, { recursive: true, force: true }));
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, "escape"), "dir");

  const patchText = `*** Begin Patch
*** Add File: escape/new.txt
+must not escape
*** End Patch`;

  assert.throws(
    () => createPatchActionDraft({
      request: {
        toolName: "write",
        cwd: workspace,
        input: { patchText },
      },
      patchText,
      allowedWritePaths: [workspace],
    }),
    /Patch path resolves outside allowed write paths: escape\/new\.txt/,
  );
});
