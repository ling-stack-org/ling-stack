import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bounded, hashFile } from "../scripts/locked-use-release-files.ts";
import { LOCKED_USE_ACCEPTANCE_CASES, sha256 } from "../scripts/locked-use-release-evidence.ts";

test("release file reads are bounded and reject directories, oversized files and symlinks", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-release-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "evidence");
  const bytes = Buffer.alloc(200_000, 42);
  await writeFile(path, bytes);
  assert.deepEqual(await bounded(path, bytes.length), bytes);
  assert.equal(await hashFile(path), sha256(bytes));
  await assert.rejects(bounded(path, bytes.length - 1), /file_invalid/u);
  await assert.rejects(bounded(root), /file_invalid/u);
  const link = join(root, "link"); await symlink(path, link);
  await assert.rejects(bounded(link)); await assert.rejects(hashFile(link));
  const sparse = await open(join(root, "oversized"), "wx");
  try { await sparse.truncate(128 * 1024 * 1024 + 1); } finally { await sparse.close(); }
  await assert.rejects(hashFile(join(root, "oversized")), /file_invalid/u);
});

test("checklist templates contain no passing evidence and never overwrite an existing review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-release-template-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "checklist.json");
  const script = fileURLToPath(new URL("../scripts/prepare-locked-use-release.ts", import.meta.url));
  const first = spawnSync(process.execPath, [script, "--template", path], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const bytes = await readFile(path);
  const template = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(template.cases), [...LOCKED_USE_ACCEPTANCE_CASES]);
  assert.ok(Object.values(template.cases).every((value) => (value as { result: string }).result === "not_run"));
  assert.notEqual(spawnSync(process.execPath, [script, "--template", path]).status, 0);
  assert.deepEqual(await readFile(path), bytes);
});
