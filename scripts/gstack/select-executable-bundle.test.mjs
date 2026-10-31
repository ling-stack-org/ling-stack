import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishFirstSelection } from "./select-executable-bundle.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-first-selection-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "selection.json") };
}

test("eight simultaneous first selections publish one complete pointer; equal bytes are idempotent", async t => {
  const { root, path } = await fixture(t), value = { root: "/fixed/bundle", identity: { manifestChecksum: "fixture-only" } };
  const results = await Promise.all(Array.from({ length: 8 }, () => publishFirstSelection(path, value)));
  assert.equal(results.filter(row => !row.reused).length, 1);
  assert.deepEqual(JSON.parse(await readFile(path)), value);
  assert.deepEqual(await readdir(root), ["selection.json"]);
});

test("a different existing selection or symlink is never overwritten or followed for mutation", async t => {
  const { path, root } = await fixture(t);
  await publishFirstSelection(path, { identity: "existing" });
  await assert.rejects(publishFirstSelection(path, { identity: "new" }), /existing_changed/);
  assert.deepEqual(JSON.parse(await readFile(path)), { identity: "existing" });
  await rm(path);
  const outside = join(root, "KEEP"); await writeFile(outside, "user data"); await symlink(outside, path);
  await assert.rejects(publishFirstSelection(path, { identity: "new" }), /file_invalid/);
  assert.equal(await readFile(outside, "utf8"), "user data");
});

test("oversized selection and unmanaged invocation cannot publish any metadata", async t => {
  const { path, root } = await fixture(t);
  await assert.rejects(publishFirstSelection(path, { large: "x".repeat(16384) }), /over_budget/);
  const result = spawnSync(process.execPath, ["scripts/gstack/select-executable-bundle.mjs", "/must-not-read", `sha256:${"a".repeat(64)}`],
    { env: { PATH: process.env.PATH, LANG: "C" }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lease_required/);
  assert.deepEqual(await readdir(root), []);
});
