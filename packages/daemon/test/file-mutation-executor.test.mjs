import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyFileMutationRecovery,
  createFileMutationActionDraft,
} from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { applyPatchActionDraft } from "../dist/features/runs/patch-actions.js";

async function fixture(t, name) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), `ling-file-mutation-${name}-`)));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

function editRequest(cwd, path, edits) {
  return {
    toolCallId: `edit-${path}`,
    toolName: "edit",
    cwd,
    task: { id: "task-edit", title: "Edit", prompt: "Edit safely" },
    input: { path, edits },
  };
}

function writeRequest(cwd, path, content = "created\n") {
  return {
    toolCallId: `write-${path}`,
    toolName: "write",
    cwd,
    task: { id: "task-write", title: "Write", prompt: "Write safely" },
    input: { path, content },
  };
}

test("exact edit rejects a missing match without creating a mutation plan", async (t) => {
  const cwd = await fixture(t, "missing");
  await writeFile(join(cwd, "source.txt"), "alpha\nbeta\n", "utf8");

  assert.throws(
    () => createFileMutationActionDraft({
      request: editRequest(cwd, "source.txt", [{ oldText: "gamma", newText: "delta" }]),
      allowedWritePaths: [cwd],
    }),
    /oldText was not found/u,
  );
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "alpha\nbeta\n");
});

test("exact edit rejects an ambiguous match instead of editing every occurrence", async (t) => {
  const cwd = await fixture(t, "ambiguous");
  await writeFile(join(cwd, "source.txt"), "same\nmiddle\nsame\n", "utf8");

  assert.throws(
    () => createFileMutationActionDraft({
      request: editRequest(cwd, "source.txt", [{ oldText: "same", newText: "changed" }]),
      allowedWritePaths: [cwd],
    }),
    /oldText matched more than once/u,
  );
});

test("exact edit rejects overlapping replacements before any file effect", async (t) => {
  const cwd = await fixture(t, "overlap");
  await writeFile(join(cwd, "source.txt"), "abcdef\n", "utf8");

  assert.throws(
    () => createFileMutationActionDraft({
      request: editRequest(cwd, "source.txt", [
        { oldText: "abcd", newText: "first" },
        { oldText: "cdef", newText: "second" },
      ]),
      allowedWritePaths: [cwd],
    }),
    /overlap/u,
  );
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "abcdef\n");
});

test("exact edit normalizes matching but preserves the file's CRLF convention", async (t) => {
  const cwd = await fixture(t, "crlf");
  await writeFile(join(cwd, "source.txt"), "first\r\nsecond\r\n", "utf8");
  const draft = createFileMutationActionDraft({
    request: editRequest(cwd, "source.txt", [{ oldText: "second\n", newText: "changed\n" }]),
    allowedWritePaths: [cwd],
  });

  const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd] });

  assert.equal(result.outcome, "applied");
  assert.equal(result.handledResult.isError, undefined);
  assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "first\r\nchanged\r\n");
});

test("atomic edits preserve the target file's executable mode", async (t) => {
  const cwd = await fixture(t, "mode");
  await writeFile(join(cwd, "script.sh"), "#!/bin/sh\necho before\n", "utf8");
  await chmod(join(cwd, "script.sh"), 0o755);
  const draft = createFileMutationActionDraft({
    request: editRequest(cwd, "script.sh", [{ oldText: "before", newText: "after" }]),
    allowedWritePaths: [cwd],
  });

  const result = await applyPatchActionDraft({ draft, cwd, allowedWritePaths: [cwd] });

  assert.equal(result.outcome, "applied");
  assert.equal((await stat(join(cwd, "script.sh"))).mode & 0o777, 0o755);
});

test("native writes reject traversal and absolute paths outside the approved scope", async (t) => {
  const container = await fixture(t, "lexical-escape");
  const cwd = join(container, "workspace");
  await mkdir(cwd);
  const outside = join(container, "outside.txt");

  for (const path of ["../outside.txt", outside]) {
    assert.throws(
      () => createFileMutationActionDraft({
        request: writeRequest(cwd, path),
        allowedWritePaths: [cwd],
      }),
      /outside allowed write paths/u,
    );
  }
});

test("native writes reject a symlink that escapes the approved workspace", async (t) => {
  const container = await fixture(t, "symlink-escape");
  const cwd = join(container, "workspace");
  const outside = join(container, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await symlink(outside, join(cwd, "escape"), "dir");

  assert.throws(
    () => createFileMutationActionDraft({
      request: writeRequest(cwd, "escape/new.txt"),
      allowedWritePaths: [cwd],
    }),
    /resolves outside allowed write paths/u,
  );
});

test("native writes reject a symlink alias into .ling-stack internal state", async (t) => {
  const cwd = await fixture(t, "internal-symlink");
  await mkdir(join(cwd, ".ling-stack"));
  await symlink(join(cwd, ".ling-stack"), join(cwd, "internal"), "dir");

  assert.throws(
    () => createFileMutationActionDraft({
      request: writeRequest(cwd, "internal/state.json", "forbidden\n"),
      allowedWritePaths: [cwd],
    }),
    /may not modify \.ling-stack internal state/u,
  );
});

test("recovery rejects a basis whose operation paths do not match its validated touched paths", async (t) => {
  const container = await fixture(t, "recovery-path-mismatch");
  const cwd = join(container, "workspace");
  await mkdir(cwd);
  const outsideContent = "outside\n";
  await writeFile(join(container, "outside.txt"), outsideContent, "utf8");

  const outcome = classifyFileMutationRecovery({
    cwd,
    allowedWritePaths: [cwd],
    basis: {
      schemaVersion: 1,
      touchedPaths: ["safe.txt"],
      operations: [{
        path: "../outside.txt",
        kind: "add",
        newSha256: createHash("sha256").update(outsideContent, "utf8").digest("hex"),
      }],
    },
  });

  assert.equal(outcome, "diverged");
});
