import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPatchActionDraft, createPatchActionDraft } from "../dist/features/runs/patch-actions.js";

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

test("a later apply failure rolls back only earlier paths from the same patch", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-patch-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "later"));
  const patchText = `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: later/second.txt
+second
*** End Patch`;
  const request = { toolName: "write", cwd, input: { patchText } };
  const draft = createPatchActionDraft({ request, patchText, allowedWritePaths: [cwd] });
  await rm(join(cwd, "later"), { recursive: true });

  const result = await applyPatchActionDraft({
    draft,
    cwd,
    allowedWritePaths: [cwd],
    requireExistingParentsForAdds: true,
  });

  assert.equal(result.handledResult.isError, true);
  assert.equal(result.handledResult.details.code, "operation_binding_parent_missing");
  assert.equal(result.outcome, "rolled_back");
  await assert.rejects(readFile(join(cwd, "first.txt"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(cwd, "later/second.txt"), "utf8"), /ENOENT/);
});

test("cancellation immediately after an atomic create rolls the file back", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-patch-cancel-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const patchText = `*** Begin Patch
*** Add File: output.txt
+created
*** End Patch`;
  const request = { toolName: "write", cwd, input: { patchText } };
  const draft = createPatchActionDraft({ request, patchText, allowedWritePaths: [cwd] });
  let checks = 0;
  const signal = {
    get aborted() { checks += 1; return checks >= 3; },
    reason: Object.assign(new Error("cancel-after-create"), { name: "AbortError" }),
  };

  const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd], signal });

  assert.equal(result.handledResult.isError, true);
  assert.equal(result.handledResult.details.cancelled, true);
  assert.equal(result.outcome, "rolled_back");
  await assert.rejects(readFile(join(cwd, "output.txt"), "utf8"), /ENOENT/);
});

test("rollback reports divergence instead of overwriting a concurrent external change", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-patch-diverged-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const patchText = `*** Begin Patch
*** Add File: output.txt
+created
*** End Patch`;
  const request = { toolName: "write", cwd, input: { patchText } };
  const draft = createPatchActionDraft({ request, patchText, allowedWritePaths: [cwd] });
  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      if (checks === 3) writeFileSync(join(cwd, "output.txt"), "external\n", "utf8");
      return checks >= 3;
    },
    reason: Object.assign(new Error("cancel-after-external-write"), { name: "AbortError" }),
  };

  const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd], signal });

  assert.equal(result.handledResult.isError, true);
  assert.equal(result.handledResult.details.status, "unknown_outcome");
  assert.equal(result.handledResult.details.code, "tool.unknown_side_effect_outcome");
  assert.equal(result.outcome, "diverged");
  assert.equal(await readFile(join(cwd, "output.txt"), "utf8"), "external\n");
});
