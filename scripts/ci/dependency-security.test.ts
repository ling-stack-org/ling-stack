import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

const entries = [
  "apps/mobile/test/dependency-security-patches.test.mjs",
  "apps/mobile/test/dependency-security-tooling.test.ts",
  "packages/daemon/test/dependency-security.test.ts",
  "scripts/dependency-security-regressions.test.mjs",
  "scripts/dependency-security-minimatch.test.ts",
  "scripts/dependency-security-glob.test.mjs",
];

function runFixture(t: TestContext, files: readonly string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-dependency-tests-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  const runner = join(root, "scripts/ci/dependency-security.mjs");
  copyFileSync(new URL("./dependency-security.mjs", import.meta.url), runner);
  const receipt = join(root, "executed.txt");
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'import { appendFileSync } from "node:fs";\n'
      + "appendFileSync(" + JSON.stringify(receipt) + ", " + JSON.stringify(file + "\n") + ");\n");
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "corepack"), [
    "#!/bin/sh",
    "set -eu",
    "[ \"$1\" = pnpm ] && [ \"$2\" = --filter ] && [ \"$4\" = exec ]",
    'case "$3" in',
    "  @ling-stack/mobile) cd apps/mobile ;;",
    "  @ling-stack/daemon) cd packages/daemon ;;",
    "  *) exit 2 ;;",
    "esac",
    "shift 4",
    'exec "$@"',
  ].join("\n") + "\n", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + ":" + process.env.PATH };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: "utf8", env });
  return { ...result, executed: existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n") : [] };
}

test("dependency security runs each registered test across mixed migrations", t => {
  const result = runFixture(t, entries);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.executed.sort(), [...entries].sort());
});

test("dependency security rejects a missing or duplicate entry before executing tests", t => {
  for (const [files, count] of [
    [entries.slice(1), 0],
    [[...entries, entries[0].replace(/\.mjs$/u, ".ts")], 2],
  ] as const) {
    const result = runFixture(t, files);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.ok(result.stderr.includes("apps/mobile/test/dependency-security-patches.test, found " + count), result.stderr);
    assert.deepEqual(result.executed, []);
  }
});
