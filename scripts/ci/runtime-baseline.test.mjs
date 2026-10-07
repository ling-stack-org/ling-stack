import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

// Value: protects=the documented minimum runtime supports actual Host transaction fences and source imports;
// fails_when=CI or the product promises a Node release without these required APIs;
// why_new=CI previously pinned 22.15 while local validation used 22.22.1; seam=none
test("product runtime floor and every CI Node setup share the validated baseline", () => {
  assert.equal(manifest.engines.node, ">=22.22.1");
  const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  const versions = [...workflow.matchAll(/node-version: (\S+)/g)].map(match => match[1]);
  assert.ok(versions.length > 0, "CI must explicitly pin a Node runtime");
  assert.deepEqual([...new Set(versions)], [manifest.engines.node.slice(2)]);
});

test("the runtime exposes real SQLite transaction state used by tracked-launch fences", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.equal(database.isTransaction, false);
    database.exec("BEGIN");
    assert.equal(database.isTransaction, true);
    database.exec("ROLLBACK");
    assert.equal(database.isTransaction, false);
  } finally {
    database.close();
  }
});

test("the runtime imports TypeScript source without an implicit external loader", t => {
  const directory = mkdtempSync(join(tmpdir(), "ling-runtime-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "baseline.mts");
  writeFileSync(source, "const value: number = 42; console.log(value);\n");
  const result = spawnSync(process.execPath, [source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "42");
});
