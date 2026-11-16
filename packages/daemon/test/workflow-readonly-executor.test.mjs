import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeWorkflowReadonlyTool } from "../dist/features/runs/workflow-readonly-executor.js";

async function fixture(t) {
  const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "ling-workflow-readonly-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "root"), outside = join(base, "outside");
  await fs.mkdir(join(root, "src"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(root, "notes.txt"), "alpha\nA+B exact\nalpha\n");
  await fs.writeFile(join(root, "src", "module.ts"), "before\nconst answer = 'A+B';\nafter\n");
  await fs.writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET_NEVER_READ");
  let checks = 0;
  const run = (toolName, input, changes = {}) => executeWorkflowReadonlyTool({ root,
    request: { toolCallId: "readonly-call", toolName, input, cwd: root, ...changes },
    assertCurrent: () => { checks++; },
  });
  return { root, outside, run, checks: () => checks };
}

function traceProducers(t) {
  const opened = [], listed = [], reads = [];
  const originalOpen = fs.open, originalOpendir = fs.opendir;
  t.mock.method(fs, "open", async (...args) => {
    opened.push(String(args[0]));
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    handle.read = (...args) => { reads.push(opened.at(-1)); return read(...args); };
    return handle;
  });
  t.mock.method(fs, "opendir", (...args) => { listed.push(String(args[0])); return originalOpendir(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { opened, listed, reads };
}

test("four Host tools read real bounded text and resolve literal workspace cwd", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  const read = await f.run("read", { path: "notes.txt", offset: 2, limit: 1 });
  assert.equal(read.isError, undefined);
  assert.match(read.content[0].text, /^A\+B exact/);
  assert.equal(read.details.truncated, true);
  const nested = await f.run("read", { path: "module.ts" }, { cwd: join(f.root, "src") });
  assert.match(nested.content[0].text, /const answer/);
  const absolute = await f.run("read", { path: join(f.root, "notes.txt") });
  assert.equal(absolute.isError, undefined);
  assert.equal((await f.run("ls", {})).content[0].text, "notes.txt\nsrc/");
  assert.equal((await f.run("find", { pattern: "**/*.ts" })).content[0].text, "src/module.ts");
  const grep = await f.run("grep", { pattern: "a+b", literal: true, ignoreCase: true, glob: "**/*.ts", context: 1 });
  assert.equal(grep.details.count, 1);
  assert.match(grep.content[0].text, /src\/module.ts:2:const answer = 'A\+B';/);
  assert.match(grep.content[0].text, /src\/module.ts:1-before/);
  assert.ok(traced.opened.length >= 4);
  assert.ok(traced.reads.length >= 4);
  assert.ok(f.checks() > traced.opened.length + traced.listed.length);
});

test("external roots, traversal and aliases reject before a content/list producer", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  for (const [tool, path] of [
    ["read", join(f.outside, "secret.txt")], ["read", "../outside/secret.txt"],
    ["grep", f.outside], ["ls", f.outside], ["find", "../outside"],
    ["read", "@secret.txt"], ["read", "~/secret.txt"], ["read", "src/../@notes.txt"], ["read", "src\\module.ts"],
  ]) {
    const result = await f.run(tool, { path, ...(tool === "grep" ? { pattern: "SECRET", literal: true } : {}),
      ...(tool === "find" ? { pattern: "*" } : {}) });
    assert.equal(result.isError, true, tool + ":" + path);
    assert.match(result.details.code, /^workflow_readonly_/);
    assert.doesNotMatch(result.content[0].text, /OUTSIDE_SECRET/);
  }
  assert.equal((await f.run("read", { path: "notes.txt" }, { cwd: f.outside })).isError, true);
  assert.deepEqual(traced.opened, []);
  assert.deepEqual(traced.listed, []);
});

test("direct symlinks, symlink parents, hardlinks and secret paths never open a producer", async t => {
  const f = await fixture(t);
  await fs.symlink(join(f.outside, "secret.txt"), join(f.root, "external-link"));
  await fs.symlink(join(f.root, "notes.txt"), join(f.root, "internal-link"));
  await fs.symlink(f.outside, join(f.root, "linked-directory"));
  await fs.link(join(f.outside, "secret.txt"), join(f.root, "hardlinked-secret"));
  for (const name of [".git", ".ling", ".ling-stack", ".ssh"]) {
    await fs.mkdir(join(f.root, name));
    await fs.writeFile(join(f.root, name, "secret.txt"), "PRIVATE_SECRET_NEVER_READ");
  }
  for (const name of [".env", ".env.local", ".ENV", ".envrc", ".npmrc", "private.key"]) {
    await fs.writeFile(join(f.root, name), "PRIVATE_SECRET_NEVER_READ");
  }
  const traced = traceProducers(t);
  for (const path of ["external-link", "internal-link", "linked-directory/secret.txt", "hardlinked-secret",
    ".git/secret.txt", ".ling/secret.txt", ".ling-stack/secret.txt", ".ssh/secret.txt", ".env", ".env.local", ".ENV", ".envrc", ".npmrc", "private.key"]) {
    assert.equal((await f.run("read", { path })).isError, true, path);
  }
  for (const path of ["external-link", "linked-directory", ".git", ".ling"]) {
    assert.equal((await f.run("ls", { path })).isError, true, path);
  }
  assert.deepEqual(traced.opened, []);
  assert.deepEqual(traced.listed, []);
  const listing = await f.run("ls", {});
  assert.doesNotMatch(listing.content[0].text, /external-link|internal-link|linked-directory|\.env|\.ling|\.git|\.ssh|private.key/i);
  const search = await f.run("grep", { pattern: "SECRET_NEVER_READ", literal: true });
  assert.equal(search.details.count, 0);
  assert.equal(search.details.skippedFiles, 1, "hardlinks are excluded even within the workspace");
  assert.ok(traced.opened.every(path => path === join(f.root, "notes.txt") || path === join(f.root, "src/module.ts")));
});

test("shell/mutation names and injected fields cannot enter the readonly producer", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  for (const tool of ["bash", "write", "edit", "__proto__", "constructor", "mcp__read"]) {
    const result = await f.run(tool, { command: "touch escaped", path: "escaped", content: "mutation" });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "workflow_readonly_tool");
  }
  const result = await f.run("read", { path: "notes.txt", command: "touch escaped" });
  assert.equal(result.isError, true);
  assert.deepEqual(traced.opened, []);
  assert.deepEqual(traced.listed, []);
  await assert.rejects(fs.stat(join(f.root, "escaped")), { code: "ENOENT" });
});

test("grep requires literal mode and rejects untrusted regex before opening files", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  for (const input of [{ pattern: "(a+)+$" }, { pattern: "(a+)+$", literal: false }, { pattern: "x", literal: "true" },
    { pattern: "x".repeat(257), literal: true }, { pattern: "x", literal: true, glob: "!(secret)" }]) {
    assert.equal((await f.run("grep", input)).isError, true);
  }
  for (const pattern of ["../*", "/tmp/*", "@(src)", "{a,b}", "[a-z]*", "a***b", "x".repeat(257)]) {
    assert.equal((await f.run("find", { pattern })).isError, true, pattern);
  }
  assert.deepEqual(traced.opened, []);
  assert.deepEqual(traced.listed, []);
});

test("invalid input never becomes a permissive default", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  const getter = Object.defineProperty({}, "path", { get() { throw new Error("must not access a getter"); } });
  for (const input of [null, [], "notes.txt", new Proxy({}, {}), getter, { path: "notes.txt", limit: 0 },
    { path: "notes.txt", limit: 1001 }, { path: "notes.txt", offset: 1.5 }, { path: "notes.txt", offset: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await f.run("read", input)).isError, true);
  }
  assert.deepEqual(traced.opened, []);
});

test("file size, binary text and output limits are enforced on real files", async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.root, "large.txt"), "x".repeat(1024 * 1024 + 1));
  await fs.writeFile(join(f.root, "long.txt"), "x".repeat(100_000));
  await fs.writeFile(join(f.root, "binary.bin"), Buffer.from([0, 255, 1]));
  const traced = traceProducers(t);
  assert.equal((await f.run("read", { path: "large.txt" })).details.code, "workflow_readonly_file_limit");
  assert.deepEqual(traced.opened, []);
  const long = await f.run("read", { path: "long.txt" });
  assert.equal(long.details.truncated, true);
  assert.ok(Buffer.byteLength(long.content[0].text) <= 32 * 1024);
  assert.equal((await f.run("read", { path: "binary.bin" })).details.code, "workflow_readonly_binary");
});

test("directory breadth, depth, result counts and aggregate bytes stay bounded", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const wide = join(f.root, "wide");
  await fs.mkdir(wide);
  for (let start = 0; start < 2050; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 2050 - start) }, (_, n) => fs.writeFile(join(wide, `${start + n}.txt`), "entry")));
  }
  const found = await f.run("find", { path: "wide", pattern: "*.txt", limit: 5 });
  assert.equal(found.isError, undefined);
  assert.equal(found.details.count, 5);
  assert.equal(found.details.truncated, true);
  assert.ok(found.details.visitedEntries <= 2048);
  let deep = join(f.root, "deep");
  for (let n = 0; n < 18; n++) { deep = join(deep, "nested"); await fs.mkdir(deep, { recursive: true }); }
  await fs.writeFile(join(deep, "too-deep.txt"), "deep");
  const depth = await f.run("find", { path: "deep", pattern: "**/*.txt" });
  assert.equal(depth.details.truncated, true);
  assert.doesNotMatch(depth.content[0].text, /too-deep/);
  await fs.mkdir(join(f.root, "bytes"));
  for (let n = 0; n < 9; n++) await fs.writeFile(join(f.root, "bytes", `${n}.txt`), "a".repeat(1024 * 1024));
  const bytes = await f.run("grep", { path: "bytes", pattern: "NEEDLE", literal: true });
  assert.equal(bytes.details.truncated, true);
  assert.equal(bytes.details.filesRead, 8);
  assert.ok(bytes.details.bytesRead <= 8 * 1024 * 1024);
});

test("cancellation and stale authority close admission before content reads", async t => {
  const f = await fixture(t), traced = traceProducers(t);
  const controller = new AbortController();
  controller.abort(new Error("fixture cancellation"));
  await assert.rejects(f.run("read", { path: "notes.txt" }, { signal: controller.signal }), /fixture cancellation/);
  const stale = new Error("fixture stale authority");
  let checks = 0;
  await assert.rejects(executeWorkflowReadonlyTool({ root: f.root,
    request: { toolCallId: "stale", toolName: "read", cwd: f.root, input: { path: "notes.txt" } },
    assertCurrent: () => { if (++checks > 5) throw stale; },
  }), error => error === stale);
  assert.deepEqual(traced.reads, []);
  assert.deepEqual(traced.opened, []);
});

test("authority revocation after open cannot admit even one descriptor read", async t => {
  const f = await fixture(t);
  let revoked = false, reads = 0, closed = false;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    handle.read = async () => { reads++; throw new Error("content producer must not run"); };
    handle.close = async () => { closed = true; return close(); };
    revoked = true;
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(executeWorkflowReadonlyTool({ root: f.root,
    request: { toolCallId: "revoked", toolName: "read", cwd: f.root, input: { path: "notes.txt" } },
    assertCurrent: () => { if (revoked) throw new Error("revoked after open"); },
  }), /revoked after open/);
  assert.equal(reads, 0);
  assert.equal(closed, true);
});

test("symlink replacement at open cannot expose external file contents", async t => {
  const f = await fixture(t);
  let reads = 0;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    await fs.rename(join(f.root, "src"), join(f.root, "original-src"));
    await fs.symlink(f.outside, join(f.root, "src"));
    const handle = await originalOpen(...args);
    handle.read = async () => { reads++; throw new Error("external descriptor must never be read"); };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await fs.writeFile(join(f.root, "src", "secret.txt"), "allowed original file");
  const result = await f.run("read", { path: "src/secret.txt" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "workflow_readonly_changed");
  assert.equal(reads, 0);
  assert.doesNotMatch(result.content[0].text, /OUTSIDE_SECRET/);
});

for (const toolName of ["read", "ls"]) {
  test(`${toolName} rejects replacement above the execution root and closes the opened handle`, async t => {
    const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "ling-workflow-readonly-ancestor-"));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const parent = join(base, "approved-parent"), outsideParent = join(base, "outside-parent");
    const root = join(parent, "workspace"), outsideRoot = join(outsideParent, "workspace");
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.writeFile(join(root, "notes.txt"), "approved content");
    await fs.writeFile(join(outsideRoot, "notes.txt"), "OUTSIDE_SECRET_NEVER_READ");
    const method = toolName === "read" ? "open" : "opendir", original = fs[method];
    let opens = 0, reads = 0, closed = false;
    t.mock.method(fs, method, async (...args) => {
      opens++;
      await fs.rename(parent, join(base, "saved-parent"));
      await fs.symlink(outsideParent, parent);
      const handle = await original(...args);
      const close = handle.close.bind(handle);
      handle.read = async () => { reads++; throw new Error("external content/list producer must not run"); };
      handle.close = async () => { closed = true; return close(); };
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await executeWorkflowReadonlyTool({ root,
      request: { toolCallId: "ancestor-replacement", toolName, cwd: root,
        input: { path: toolName === "read" ? "notes.txt" : "." } },
      assertCurrent() {},
    });
    assert.equal(opens, 1, "the actual native open must encounter the replaced ancestor");
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "workflow_readonly_changed");
    assert.equal(reads, 0);
    assert.equal(closed, true);
    assert.doesNotMatch(result.content[0].text, /OUTSIDE_SECRET/);
  });
}
