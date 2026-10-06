import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Value: protects=public scans distinguish the fixed macOS system Preboot path from private volume paths;
// fails_when=the OS path is falsely blocked or arbitrary private volumes are exempted;
// why_new=the existing CI scanner has no behavioral regression tests; seam=none
const scanner = join(dirname(fileURLToPath(import.meta.url)), "check-public-repo-safety.mjs");

function scan(t, content) {
  const root = mkdtempSync(join(tmpdir(), "ling-public-safety-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(scanner, join(root, "scripts", "check-public-repo-safety.mjs"));
  writeFileSync(join(root, "fixture.mjs"), content);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  return spawnSync(process.execPath, ["scripts/check-public-repo-safety.mjs"], { cwd: root, encoding: "utf8" });
}

test("macOS system Preboot path does not imply a personal volume", t => {
  const result = scan(t, JSON.stringify(["", "System", "Volumes", "Preboot", "Cryptexes", "OS"].join("/")));
  assert.equal(result.status, 0, result.stderr);
});

for (const segments of [["", "Volumes", "Preboot", "personal"], ["", "private", "System", "Volumes", "Preboot"], ["", "System", "Volumes", "private-owner"], ["", "Users", "private-owner", "project"]]) {
  test(`private path remains blocked: ${segments.slice(1).join(" > ")}`, t => {
    const result = scan(t, JSON.stringify(segments.join("/")));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /personal macOS (?:user|volume) path/u);
  });
}

test("unknown provider key is blocked without echoing its bytes", t => {
  const key = "sk-" + "R".repeat(32);
  const result = scan(t, JSON.stringify(key));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /model provider key/u);
  assert.equal(result.stderr.includes(key), false);
});
