import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { measureBrowserProfileSize } from "../dist/main/browser/profile-size.js";

test("browser profile size counts only its persistent storage and metadata", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ling-browser-size-"));
  try {
    const profile = join(root, "profile"), outside = join(root, "outside"), metadata = join(root, "metadata.json");
    await mkdir(join(profile, "Cache"), { recursive: true });
    await writeFile(join(profile, "Cache", "entry"), Buffer.alloc(9));
    await writeFile(outside, Buffer.alloc(50));
    await writeFile(metadata, Buffer.alloc(4));
    await symlink(outside, join(profile, "linked"));
    const result = await measureBrowserProfileSize(profile, metadata);
    assert.equal(result.status, "complete");
    assert.equal(result.knownBytes, 13);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("browser profile size stops inside a flat directory when its deadline expires", async t => {
  const profile = await mkdtemp(join(await realpath(tmpdir()), "ling-browser-size-budget-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, "first"), Buffer.alloc(9));
  await writeFile(join(profile, "second"), Buffer.alloc(9));
  let samples = 0;
  t.mock.method(Date, "now", () => ++samples <= 3 ? 0 : 20_001);
  assert.deepEqual(await measureBrowserProfileSize(profile), {
    category: "browser", knownBytes: 9, status: "partial", reason: "deadline",
  });
});

test("browser profile size shares the entry limit across workspace profiles", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ling-browser-size-shared-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await writeFile(join(first, "entry"), Buffer.alloc(9));
  await writeFile(join(second, "entry"), Buffer.alloc(12));
  const budget = { deadlineMs: Date.now() + 20_000, remainingEntries: 1 };
  assert.deepEqual(await measureBrowserProfileSize(first, undefined, budget), {
    category: "browser", knownBytes: 9, status: "complete",
  });
  assert.deepEqual(await measureBrowserProfileSize(second, undefined, budget), {
    category: "browser", knownBytes: 0, status: "partial", reason: "entry_limit",
  });
});

test("browser profile size stops when a replaced scan is cancelled", async t => {
  const profile = await mkdtemp(join(await realpath(tmpdir()), "ling-browser-size-cancel-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  await writeFile(join(profile, "entry"), Buffer.alloc(9));
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await measureBrowserProfileSize(profile, undefined,
    { deadlineMs: Date.now() + 20_000, remainingEntries: 300_000, signal: controller.signal }), {
    category: "browser", knownBytes: 0, status: "partial", reason: "deadline",
  });
});

test("browser profile size rejects a storage root reached through a symlink", async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "ling-browser-size-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = join(root, "owned"), alias = join(root, "alias");
  await mkdir(join(owned, "profile"), { recursive: true });
  await writeFile(join(owned, "profile", "entry"), Buffer.alloc(9));
  await symlink(owned, alias, "junction");
  assert.deepEqual(await measureBrowserProfileSize(join(alias, "profile")), {
    category: "browser", knownBytes: 0, status: "partial", reason: "read_error",
  });
});
