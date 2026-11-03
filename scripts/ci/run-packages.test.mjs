import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function fixture(t, scripts) {
  const root = mkdtempSync(join(tmpdir(), "ling-ci-packages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  mkdirSync(join(root, "packages/probe"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  const runner = join(root, "scripts/ci/run-packages.mjs");
  copyFileSync(new URL("./run-packages.mjs", import.meta.url), runner);
  writeFileSync(join(root, "packages/probe/package.json"), JSON.stringify({ name: "@ling-stack/probe", scripts }));
  writeFileSync(join(root, "bin/corepack"), '#!/bin/sh\nprintf "invoked:%s\\n" "$@"\n', { mode: 0o755 });
  return (...args) => spawnSync(process.execPath, [runner, ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
}

test("selected validation packages must have a nonempty script before pnpm can execute", (t) => {
  for (const scripts of [{}, { "test:ci": "" }, { "test:ci": " " }]) {
    const run = fixture(t, scripts);
    const result = run("--task=test:ci", '--packages=["@ling-stack/probe"]');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Selected packages missing test:ci: @ling-stack\/probe/u);
    assert.doesNotMatch(result.stdout, /invoked:/u);
  }
});

test("unknown selections fail even when other selected packages have scripts", (t) => {
  const result = fixture(t, { "typecheck:ci": "tsc" })("--task=typecheck:ci",
    '--packages=["@ling-stack/probe","@ling-stack/missing"]');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing typecheck:ci: @ling-stack\/missing/u);
  assert.doesNotMatch(result.stdout, /invoked:/u);
});

test("valid selected tasks run without if-present, and empty selections do no work", (t) => {
  const run = fixture(t, { "test:ci": "node --test" });
  const result = run("--task=test:ci", '--packages=["@ling-stack/probe"]');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /invoked:run\ninvoked:test:ci/u);
  assert.doesNotMatch(result.stdout, /--if-present/u);
  const empty = run("--task=test:ci", '--packages=["@ling-stack/probe"]', '--exclude=["@ling-stack/probe"]');
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No packages selected/u);
  assert.doesNotMatch(empty.stdout, /invoked:/u);
});

test("build closures keep artifact-free dependency workspaces optional", (t) => {
  const result = fixture(t, {})("--task=build:ci", '--packages=["@ling-stack/probe"]', "--closure=true");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /invoked:@ling-stack\/probe\.\.\./u);
  assert.match(result.stdout, /invoked:--if-present/u);
});
