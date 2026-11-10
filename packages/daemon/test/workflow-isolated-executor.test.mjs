import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeWorkflowIsolatedTool } from "../dist/features/runs/workflow-isolated-executor.js";

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-isolated-tool-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "isolated"), target = join(base, "target"), sibling = join(base, "sibling");
  for (const directory of [root, target, sibling, join(root, "src")]) await mkdir(directory);
  await writeFile(join(root, "src", "sample.txt"), "one\ntwo\nthree\n");
  await writeFile(join(target, "keep.txt"), "USER_CHECKOUT");
  await writeFile(join(sibling, "keep.txt"), "OTHER_BRANCH");
  const run = (toolName, input, options = {}) => executeWorkflowIsolatedTool({ root,
    request: { toolCallId: "isolated-call", toolName, cwd: root, input, ...options.request },
    assertCurrent: options.assertCurrent ?? (() => {}),
  });
  return { base, root, target, sibling, run };
}

test("isolated Host tools read, write and exact-edit real branch files without touching other checkouts", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  const read = await f.run("read", { path: "src/sample.txt" });
  assert.equal(read.isError, undefined);
  assert.equal(read.content[0].text, "one\ntwo\nthree\n");
  const write = await f.run("write", { path: "new.txt", content: "new branch text\n" });
  assert.equal(write.isError, undefined, JSON.stringify(write));
  assert.equal(write.details.profile, "host_isolated_files_v1");
  assert.equal(await readFile(join(f.root, "new.txt"), "utf8"), "new branch text\n");
  const edit = await f.run("edit", { path: "src/sample.txt", edits: [{ oldText: "two", newText: "replaced" }] });
  assert.equal(edit.isError, undefined, JSON.stringify(edit));
  assert.equal(await readFile(join(f.root, "src/sample.txt"), "utf8"), "one\nreplaced\nthree\n");
  assert.equal(await readFile(join(f.target, "keep.txt"), "utf8"), "USER_CHECKOUT");
  assert.equal(await readFile(join(f.sibling, "keep.txt"), "utf8"), "OTHER_BRANCH");
});

test("isolated file tools reject external roots, Git metadata, aliases and unsupported effects", async t => {
  const f = await fixture(t);
  for (const path of [join(f.target, "keep.txt"), join(f.sibling, "keep.txt"), "../target/keep.txt",
    ".git", ".git/config", ".git/../escaped.txt", ".gitattributes", ".gitmodules", ".env", ".env.local",
    ".ling/private", ".ssh/key", "@file", "~/file", "src\\sample.txt"]) {
    const result = await f.run("write", { path, content: "MUST_NOT_WRITE" });
    assert.equal(result.isError, true, path);
    assert.match(result.details.code, /^workflow_isolated_/);
  }
  for (const toolName of ["bash", "mcp__write", "native_file_create", "__proto__"]) {
    assert.equal((await f.run(toolName, { path: "escaped.txt", content: "MUST_NOT_WRITE" })).isError, true);
  }
  assert.equal((await f.run("write", { path: "new.txt", content: "NO" }, { request: { cwd: f.target } })).isError, true);
  assert.equal(await readFile(join(f.target, "keep.txt"), "utf8"), "USER_CHECKOUT");
  assert.equal(await readFile(join(f.sibling, "keep.txt"), "utf8"), "OTHER_BRANCH");
  await assert.rejects(readFile(join(f.root, "escaped.txt")), { code: "ENOENT" });
});

test("symlinks, linked parents, hardlinks and absent parents never become writable", async t => {
  const f = await fixture(t);
  await symlink(join(f.target, "keep.txt"), join(f.root, "symlink.txt"));
  await symlink(f.target, join(f.root, "linked"));
  await link(join(f.target, "keep.txt"), join(f.root, "hardlink.txt"));
  for (const path of ["symlink.txt", "linked/keep.txt", "hardlink.txt", "absent/new.txt", "."]) {
    assert.equal((await f.run("write", { path, content: "MUST_NOT_WRITE" })).isError, true, path);
  }
  assert.equal(await readFile(join(f.target, "keep.txt"), "utf8"), "USER_CHECKOUT");
});

test("invalid text and input and nonunique edits leave the original file unchanged", async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, "repeat.txt"), "repeat repeat");
  const getter = Object.defineProperty({ path: "src/sample.txt" }, "content", { get() { throw new Error("getter entered"); } });
  for (const input of [null, [], new Proxy({}, {}), getter, { path: "src/sample.txt", content: "x", command: "run" },
    { path: "src/sample.txt", content: "x\0y" }, { path: "src/sample.txt", content: "x".repeat(1024 * 1024 + 1) },
    { path: "src/sample.txt", content: "\ud800" }]) {
    assert.equal((await f.run("write", input)).isError, true);
  }
  for (const input of [{ path: "repeat.txt", edits: [{ oldText: "repeat", newText: "new" }] },
    { path: "repeat.txt", edits: [{ oldText: "", newText: "new" }] },
    { path: "repeat.txt", edits: [{ oldText: "missing", newText: "new" }] },
    { path: "repeat.txt", edits: [] }, { path: "repeat.txt", edits: "[]" },
    { path: "src/sample.txt", edits: [{ oldText: "one\ntwo", newText: "x" }, { oldText: "two\nthree", newText: "y" }] }]) {
    assert.equal((await f.run("edit", input)).isError, true);
  }
  assert.equal(await readFile(join(f.root, "src/sample.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.equal(await readFile(join(f.root, "repeat.txt"), "utf8"), "repeat repeat");
});

test("multiple exact edits match the original once, independent of replacement order", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  const result = await f.run("edit", { path: "src/sample.txt", edits: [
    { oldText: "three", newText: "one" }, { oldText: "one", newText: "three" },
  ] });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(await readFile(join(f.root, "src/sample.txt"), "utf8"), "three\ntwo\none\n");
});

test("cancelled and stale authority reject before any write", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("cancelled isolated execution"));
  await assert.rejects(f.run("write", { path: "new.txt", content: "NO" }, { request: { signal: controller.signal } }), /cancelled isolated execution/);
  const stale = new Error("stale isolated fence");
  await assert.rejects(f.run("write", { path: "new.txt", content: "NO" }, { assertCurrent: () => { throw stale; } }), error => error === stale);
  await assert.rejects(readFile(join(f.root, "new.txt")), { code: "ENOENT" });
});

test("revocation after a real write reports effect unknown instead of authorizing a retry", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), path = join(f.root, "src/sample.txt");
  await assert.rejects(f.run("write", { path, content: "WRITTEN" }, { assertCurrent: () => {
    if (readFileSync(path, "utf8") === "WRITTEN") throw new Error("revoked after producer");
  } }), { code: "workflow_isolated_write_effect_unknown" });
  assert.equal(await readFile(path, "utf8"), "WRITTEN");
});
