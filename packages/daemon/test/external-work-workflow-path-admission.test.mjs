import assert from "node:assert/strict";
import fsModule from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { admitExternalWorkflowPath, readAdmittedExternalWorkflowFile,
  writeAdmittedExternalWorkflowFile } from "../dist/features/external-work/workflow-path-admission.js";

/** Capture only this fixture's outside tree; never follow a link into another owner. */
async function treeSnapshot(directory, prefix = "") {
  const rows = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      rows.push({ path: relative, type: "directory" });
      rows.push(...await treeSnapshot(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      rows.push({ path: relative, type: "file", bytes: (await readFile(join(directory, entry.name))).toString("base64") });
    } else {
      assert.fail(`Unexpected non-file fixture member: ${relative}`);
    }
  }
  return rows;
}

async function fixture(t) {
  const container = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-path-admission-")));
  const root = join(container, "workspace");
  const outside = join(container, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "owned outside sentinel\n", "utf8");
  const outsideBefore = await treeSnapshot(outside);
  const stores = new Map();
  let runnerCalls = 0;
  let providerCalls = 0;
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: root }, {
    storeFactory: cwd => {
      assert.equal(cwd, root, "this fixture must not open a store outside its dedicated workspace");
      let store = stores.get(cwd);
      if (!store) { store = createSqliteRunStore(cwd); stores.set(cwd, store); }
      return store;
    },
    runner: { async runTask() { runnerCalls += 1; throw new Error("Workflow configuration must not run an Agent"); } },
    externalWorkFetch: async () => { providerCalls += 1; throw new Error("Workflow configuration must not call a provider"); },
  });
  t.after(async () => {
    try { await daemon.stop(); }
    finally { await rm(container, { recursive: true, force: true }); }
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const store = stores.get(root);
  assert.ok(store);
  const channel = store.createChannel({ name: "Owned workflow path fixture", boundPath: root }, new Date().toISOString());
  const endpoint = `http://127.0.0.1:${address.port}/external-work/workflow/configure?cwd=${encodeURIComponent(root)}`;
  return {
    root, outside,
    async configure(workflowPath, channelId = channel.id) {
      const response = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(4_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify({
          channelId, sourceKind: "github", repository: "fixture-owner/fixture-repository", workflowPath,
        }) });
      const body = await response.json();
      return { status: response.status, body };
    },
    async assertOutsideUnchanged() {
      assert.deepEqual(await treeSnapshot(outside), outsideBefore,
        "a rejected workflow path must not create any outside directory or file, or modify existing outside bytes");
      assert.equal(runnerCalls, 0);
      assert.equal(providerCalls, 0);
    },
  };
}

test("workflow configure rejects an existing outside symlink before creating missing parent directories", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await symlink(f.outside, join(f.root, "escape"), "dir");
  const result = await f.configure("escape/new/deep/WORKFLOW.md");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_request");
  assert.match(result.body.message, /inside the channel bound path/);
  // This is a stable pre-existing link, not a simulated rename race or hostile user directory.
  await f.assertOutsideUnchanged();
});

test("workflow configure can create legitimate nested missing parents without provider or Runner work", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const path = "legitimate/new/deep/WORKFLOW.md";
  const result = await f.configure(path);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflowCreated, true);
  assert.equal(result.body.workflowUpdated, true);
  assert.equal(result.body.workflow.valid, true);
  assert.equal(result.body.workflow.repository, "fixture-owner/fixture-repository");
  const markdown = await readFile(join(f.root, path), "utf8");
  assert.match(markdown, /repository: fixture-owner\/fixture-repository/);
  await f.assertOutsideUnchanged();
});

test("workflow configure preserves an admitted existing file on repeated configuration", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const path = "admitted/WORKFLOW.md";
  const first = await f.configure(path);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const before = await readFile(join(f.root, path), "utf8");
  const second = await f.configure(path);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.workflowCreated, false);
  assert.equal(second.body.workflowUpdated, false);
  assert.equal(await readFile(join(f.root, path), "utf8"), before);
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects an existing file symlink to outside without rewriting it", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await symlink(join(f.outside, "keep.txt"), join(f.root, "WORKFLOW.md"), "file");
  const result = await f.configure("WORKFLOW.md");
  assert.equal(result.status, 400);
  assert.match(result.body.message, /inside the channel bound path/);
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects lexical escape, directory target, and missing channel without target effects", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const directory = join(f.root, "occupied");
  await mkdir(directory);
  await writeFile(join(directory, "keep.txt"), "existing directory sentinel\n", "utf8");
  const before = await treeSnapshot(directory);
  for (const path of [join(f.outside, "absolute/new/WORKFLOW.md"), "../outside/relative/new/WORKFLOW.md"]) {
    const result = await f.configure(path);
    assert.equal(result.status, 400);
    assert.match(result.body.message, /inside the channel bound path/);
  }
  const occupied = await f.configure("occupied");
  assert.equal(occupied.status, 400);
  assert.match(occupied.body.message, /not a file/);
  assert.deepEqual(await treeSnapshot(directory), before);
  const missing = await f.configure("must-not-be-created/WORKFLOW.md", "channel_missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "channel_not_found");
  assert.equal((await readdir(f.root)).includes("must-not-be-created"), false);
  await f.assertOutsideUnchanged();
});

test("workflow configure retains the default WORKFLOW.md path", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const result = await f.configure(undefined);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflow.path, join(f.root, "WORKFLOW.md"));
  assert.equal(result.body.workflow.valid, true);
  assert.equal(result.body.workflowCreated, true);
  assert.equal(result.body.workflowUpdated, true);
  assert.match(await readFile(join(f.root, "WORKFLOW.md"), "utf8"), /repository: fixture-owner\/fixture-repository/);
  await f.assertOutsideUnchanged();
});

test("workflow configure preserves an inside directory alias and creates only its canonical nested parents", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const destination = join(f.root, "inside-destination");
  await mkdir(destination);
  await symlink(destination, join(f.root, "inside-alias"), "dir");
  const result = await f.configure("inside-alias/new/deep/WORKFLOW.md");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflow.path, join(destination, "new/deep/WORKFLOW.md"));
  assert.equal(result.body.workflow.valid, true);
  assert.equal((await lstat(join(f.root, "inside-alias"))).isSymbolicLink(), true);
  assert.match(await readFile(join(destination, "new/deep/WORKFLOW.md"), "utf8"), /source:\n  kind: github/);
  await f.assertOutsideUnchanged();
});

test("workflow configure keeps an existing valid file alias and its bytes", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const created = await f.configure("inside/WORKFLOW.md");
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const destination = join(f.root, "inside/WORKFLOW.md");
  const before = await readFile(destination);
  await symlink(destination, join(f.root, "alias.md"), "file");
  const result = await f.configure("alias.md");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflow.path, destination);
  assert.equal(result.body.workflowCreated, false);
  assert.equal(result.body.workflowUpdated, false);
  assert.deepEqual(await readFile(destination), before);
  assert.equal((await lstat(join(f.root, "alias.md"))).isSymbolicLink(), true);
  await f.assertOutsideUnchanged();
});

/** Original syscall interception, limited to owned fixture paths; not an OS race or sandbox proof. */
async function withFsMethods(replacements, work) {
  const originals = Object.fromEntries(Object.keys(replacements).map(name => [name, fsModule[name]]));
  try {
    for (const [name, replace] of Object.entries(replacements)) {
      fsModule[name] = function (...args) { return replace(originals[name], ...args); };
    }
    syncBuiltinESMExports();
    return await work();
  } finally {
    for (const [name, original] of Object.entries(originals)) fsModule[name] = original;
    syncBuiltinESMExports();
  }
}

test("workflow configure opens an existing valid read-only file only for reading and preserves its mode", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const created = await f.configure("read-only.md");
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const path = join(f.root, "read-only.md");
  await chmod(path, 0o444);
  const before = await readFile(path);
  const beforeStat = await stat(path);
  const result = await f.configure("read-only.md");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflowUpdated, false);
  assert.deepEqual(await readFile(path), before);
  const afterStat = await stat(path);
  assert.equal(afterStat.mode, beforeStat.mode);
  assert.equal(afterStat.ino, beforeStat.ino);
  await f.assertOutsideUnchanged();
});

test("workflow configure repairs an existing invalid file through an inside alias without replacing the alias or file identity", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const destination = join(f.root, "invalid.md");
  await writeFile(destination, "An invalid body whose old trailing bytes must be removed.\n".repeat(100), "utf8");
  await chmod(destination, 0o600);
  const before = await stat(destination);
  await symlink(destination, join(f.root, "invalid-alias.md"), "file");
  const result = await f.configure("invalid-alias.md");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflow.path, destination);
  assert.equal(result.body.workflowCreated, false);
  assert.equal(result.body.workflowUpdated, true);
  assert.equal(result.body.workflow.valid, true);
  const bytes = await readFile(destination, "utf8");
  assert.ok(bytes.startsWith("---\nsource:\n  kind: github\n"));
  assert.doesNotMatch(bytes, /old trailing bytes/);
  const after = await stat(destination);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal((await lstat(join(f.root, "invalid-alias.md"))).isSymbolicLink(), true);
  await f.assertOutsideUnchanged();
});

test("workflow configure repairs a canonical invalid file without truncating it before FD validation", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const path = join(f.root, "invalid-canonical.md");
  await writeFile(path, "Invalid canonical input with old trailing content.\n".repeat(100), "utf8");
  const before = await stat(path);
  const result = await f.configure("invalid-canonical.md");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.workflow.path, path);
  assert.equal(result.body.workflowCreated, false);
  assert.equal(result.body.workflowUpdated, true);
  assert.equal(result.body.workflow.valid, true);
  const markdown = await readFile(path, "utf8");
  assert.ok(markdown.startsWith("---\nsource:\n  kind: github\n"));
  assert.doesNotMatch(markdown, /old trailing content/);
  assert.equal((await stat(path)).ino, before.ino);
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects a dangling parent alias without creating its destination", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const missingDestination = join(f.root, "not-created");
  await symlink(missingDestination, join(f.root, "dangling-parent"), "dir");
  const result = await f.configure("dangling-parent/new/deep/WORKFLOW.md");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_request");
  assert.equal((await lstat(join(f.root, "dangling-parent"))).isSymbolicLink(), true);
  await assert.rejects(lstat(missingDestination), error => error.code === "ENOENT");
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects a dangling target alias without creating or rewriting its destination", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const missingDestination = join(f.root, "not-created.md");
  await symlink(missingDestination, join(f.root, "WORKFLOW.md"), "file");
  const result = await f.configure(undefined);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_request");
  assert.equal((await lstat(join(f.root, "WORKFLOW.md"))).isSymbolicLink(), true);
  await assert.rejects(lstat(missingDestination), error => error.code === "ENOENT");
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects a non-directory parent without treating ENOTDIR as missing", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const parent = join(f.root, "parent-file");
  await writeFile(parent, "parent file sentinel\n", "utf8");
  const result = await f.configure("parent-file/new/WORKFLOW.md");
  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_request");
  assert.match(result.body.message, /not a directory/);
  assert.equal(await readFile(parent, "utf8"), "parent file sentinel\n");
  await f.assertOutsideUnchanged();
});

test("workflow configure propagates a non-ENOENT ancestor lstat failure before creating anything",
  { timeout: 10_000, skip: process.platform === "darwin" }, async t => {
  const f = await fixture(t);
  const ancestor = join(f.root, "denied");
  let faults = 0;
  let mkdirCalls = 0;
  const result = await withFsMethods({
    lstatSync(original, file, ...rest) {
      if (file === ancestor) { faults += 1; throw Object.assign(new Error("fixture ancestor EACCES"), { code: "EACCES" }); }
      return original(file, ...rest);
    },
    mkdirSync(original, file, ...rest) {
      if (file === ancestor || String(file).startsWith(ancestor + "/")) mkdirCalls += 1;
      return original(file, ...rest);
    },
  }, () => f.configure("denied/new/WORKFLOW.md"));
  assert.equal(faults, 1);
  assert.equal(result.status, 400);
  assert.match(result.body.message, /fixture ancestor EACCES/);
  assert.equal(mkdirCalls, 0);
  await assert.rejects(lstat(ancestor), error => error.code === "ENOENT");
  await f.assertOutsideUnchanged();
});

test("workflow configure does not follow or retry an EEXIST parent creation conflict",
  { timeout: 10_000, skip: process.platform === "darwin" }, async t => {
  const f = await fixture(t);
  const parent = join(f.root, "conflict-parent");
  let attempts = 0;
  const result = await withFsMethods({
    mkdirSync(original, file, ...rest) {
      if (file === parent) {
        attempts += 1;
        original(file, ...rest);
        throw Object.assign(new Error("fixture parent EEXIST"), { code: "EEXIST" });
      }
      return original(file, ...rest);
    },
  }, () => f.configure("conflict-parent/new/WORKFLOW.md"));
  assert.equal(result.status, 400);
  assert.equal(attempts, 1);
  assert.deepEqual(await readdir(parent), [], "only this owned inside directory may remain after the conflict");
  await f.assertOutsideUnchanged();
});

test("workflow configure creates a new file exclusively and never overwrites a concurrent target",
  { timeout: 10_000, skip: process.platform === "darwin" }, async t => {
  const f = await fixture(t);
  const path = join(f.root, "exclusive.md");
  const sentinel = "fixture target appeared before the exclusive open\n";
  let conflicts = 0;
  const result = await withFsMethods({
    openSync(original, file, flags, ...rest) {
      if (file === path && typeof flags === "number" && (flags & fsModule.constants.O_EXCL) !== 0) {
        conflicts += 1;
        fsModule.writeFileSync(path, sentinel, "utf8");
      }
      return original(file, flags, ...rest);
    },
  }, () => f.configure("exclusive.md"));
  assert.equal(result.status, 400);
  assert.equal(conflicts, 1);
  assert.equal(await readFile(path, "utf8"), sentinel);
  await f.assertOutsideUnchanged();
});

test("workflow configure rejects a replaced invalid file before truncation or writing",
  { timeout: 10_000, skip: process.platform === "darwin" }, async t => {
  const f = await fixture(t);
  const path = join(f.root, "replace-before-update.md");
  const saved = join(f.root, "old-invalid.md");
  const invalid = "Original invalid workflow bytes\n";
  const replacement = "Replacement must never be truncated\n";
  await writeFile(path, invalid, "utf8");
  let replacements = 0;
  const result = await withFsMethods({
    openSync(original, file, flags, ...rest) {
      if (file === path && typeof flags === "number" && (flags & fsModule.constants.O_RDWR) !== 0) {
        replacements += 1;
        fsModule.renameSync(path, saved);
        fsModule.writeFileSync(path, replacement, "utf8");
      }
      return original(file, flags, ...rest);
    },
  }, () => f.configure("replace-before-update.md"));
  assert.equal(result.status, 400);
  assert.match(result.body.message, /changed during configuration/);
  assert.equal(replacements, 1);
  assert.equal(await readFile(path, "utf8"), replacement);
  assert.equal(await readFile(saved, "utf8"), invalid);
  await f.assertOutsideUnchanged();
});

test("workflow configure closes a partially written owned file and reports failure without replay or pathname cleanup",
  { timeout: 10_000, skip: process.platform === "darwin" }, async t => {
  const f = await fixture(t);
  const path = join(f.root, "partial.md");
  let targetFd;
  let writes = 0;
  let closes = 0;
  const result = await withFsMethods({
    openSync(original, file, flags, ...rest) {
      const fd = original(file, flags, ...rest);
      if (file === path && typeof flags === "number" && (flags & fsModule.constants.O_EXCL) !== 0) targetFd = fd;
      return fd;
    },
    writeSync(original, fd, bytes, offset, length, position) {
      if (fd === targetFd) {
        writes += 1;
        if (writes === 1) return original(fd, bytes, offset, Math.min(length, 3), position);
        throw Object.assign(new Error("fixture partial write EIO"), { code: "EIO" });
      }
      return original(fd, bytes, offset, length, position);
    },
    closeSync(original, fd) {
      if (fd === targetFd) closes += 1;
      return original(fd);
    },
  }, () => f.configure("partial.md"));
  assert.equal(result.status, 400);
  assert.match(result.body.message, /fixture partial write EIO/);
  assert.equal(writes, 2, "the failed operation must not be replayed");
  assert.equal(closes, 1);
  assert.equal((await readFile(path)).toString("utf8"), "---");
  await f.assertOutsideUnchanged();
});

test("workflow file IO rejects a replaced root identity between admitted stages before creating a file", async t => {
  const container = await realpath(await mkdtemp(join(tmpdir(), "ling-workflow-root-identity-")));
  t.after(() => rm(container, { recursive: true, force: true }));
  const root = join(container, "workspace");
  const movedRoot = join(container, "moved-workspace");
  await mkdir(root);
  const admission = admitExternalWorkflowPath(root, "new/WORKFLOW.md");
  const snapshot = readAdmittedExternalWorkflowFile(admission);
  assert.equal(snapshot.exists, false);
  await rename(root, movedRoot);
  await mkdir(root);
  assert.throws(() => writeAdmittedExternalWorkflowFile(admission, snapshot, "must not be written\n"),
    /changed during configuration/);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await readdir(join(movedRoot, "new")), []);
  t.diagnostic("Actual owned root replacement between helper stages; not an inter-syscall race, process sandbox, or unchanged-root proof.");
});
