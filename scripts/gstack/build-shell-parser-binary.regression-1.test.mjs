import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression: MAIN-INTEGRATION binary parser builds retain E6 input/environment isolation.
// Found by /qa on 2026-10-26.
// Report: output/e6-20260928/p5-main-integration-20261026/qa-report-main-integration-2026-10-26.md
// Compiler, native verification and lease admission are synthetic; no real Go/native/package acceptance.
async function fixture(t, { changedCopy = false, changedSecondBuild = false, compilerFailure = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gstack-binary-parser-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchPath = join(root, "scratch"), calls = [], key = `binaryParserProbe${Math.random().toString(36).slice(2)}`;
  await mkdir(join(scratchPath, "tmp"), { recursive: true });
  const script = new URL("./build-shell-parser-binary.mjs", import.meta.url);
  let builds = 0;
  globalThis[key] = { fs: { ...fs, copyFile: async (from, to, ...options) => {
    if (changedCopy && from.endsWith("/main.go")) await writeFile(to, "package main // unrecorded copy\n");
    else await fs.copyFile(from, to, ...options);
  } }, requireResourceLease: async () => ({ root, scratchPath }), resourceCheckpoint: async () => {},
  exec: (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === "version") return "go version go99.0.0 synthetic";
    assert.equal(args[0], "build");
    if (compilerFailure) throw Object.assign(new Error("synthetic compiler failed before drain evidence"), { code: "ETIMEDOUT" });
    builds++;
    writeFileSync(args[args.indexOf("-o") + 1], changedSecondBuild ? `synthetic-${builds}` : "same synthetic binary");
    return "";
  } };
  const replacements = [
    ['import { execFileSync } from "node:child_process";', `const execFileSync = globalThis[${JSON.stringify(key)}].exec;`],
    [/import \{ ([^\n]+) \} from "node:fs\/promises";/, `const { $1 } = globalThis[${JSON.stringify(key)}].fs;`],
    ['import { assertNativeTarget } from "./build-native-runtime.mjs";', "const assertNativeTarget = () => {};"],
    ['import { requireResourceLease, resourceCheckpoint, within } from "./resource-workspace.mjs";',
      `import { within } from ${JSON.stringify(new URL("./resource-workspace.mjs", import.meta.url).href)}; const { requireResourceLease, resourceCheckpoint } = globalThis[${JSON.stringify(key)}];`],
    ["dirname(fileURLToPath(import.meta.url))", JSON.stringify(dirname(fileURLToPath(script)))],
  ];
  let source = await readFile(script, "utf8");
  for (const [before, after] of replacements) {
    const updated = source.replace(before, after);
    assert.notEqual(updated, source, `instrumentation boundary ${String(before)}`);
    source = updated;
  }
  source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, script).href)}`);
  try {
    const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    return { ...api, root, scratchPath, calls, outputPath: join(scratchPath, "binary"), goCommand: process.execPath };
  } finally { delete globalThis[key]; }
}

test("binary output keeps isolated compiler inputs and emits its own repeated-build provenance", async t => {
  const f = await fixture(t), previous = process.env.LING_PARSER_TEST_SECRET;
  process.env.LING_PARSER_TEST_SECRET = "synthetic-do-not-inherit";
  t.after(() => {
    if (previous === undefined) delete process.env.LING_PARSER_TEST_SECRET;
    else process.env.LING_PARSER_TEST_SECRET = previous;
  });
  const report = await f.buildShellParser(f);
  for (const { args, options: { env, cwd } } of f.calls) {
    assert.equal(env.LING_PARSER_TEST_SECRET, undefined);
    assert.equal(env.GOTOOLCHAIN, "local");
    assert.equal(env.GOCACHE, join(f.root, "cache/go-build"));
    assert.equal(env.GOMODCACHE, join(f.root, "cache/go-modules"));
    assert.equal(env.HOME, join(f.scratchPath, "home"));
    if (args[0] === "build") assert.ok(cwd.startsWith(f.scratchPath + "/"));
  }
  assert.equal(f.calls.filter(call => call.args[0] === "build").length, 2);
  assert.equal(report.binding, "pinned-module-and-repeated-native-byte-identity");
  assert.equal(report.producer.path, "scripts/gstack/build-shell-parser-binary.mjs");
  assert.deepEqual(JSON.parse(await readFile(`${f.outputPath}.provenance.json`, "utf8")), report);
  assert.equal(await readFile(f.outputPath, "utf8"), "same synthetic binary");
  assert.deepEqual(await fs.readdir(join(f.scratchPath, "tmp")), []);
});

test("a changed copied input is rejected before executing any compiler command", async t => {
  const f = await fixture(t, { changedCopy: true });
  await assert.rejects(f.buildShellParser(f), /copy_snapshot_changed/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.outputPath), { code: "ENOENT" });
});

test("different bytes from the repeated build cannot publish a binary or provenance", async t => {
  const f = await fixture(t, { changedSecondBuild: true });
  await assert.rejects(f.buildShellParser(f), /repeated_build_changed/);
  await assert.rejects(readFile(f.outputPath), { code: "ENOENT" });
  await assert.rejects(readFile(`${f.outputPath}.provenance.json`), { code: "ENOENT" });
});

test("failed compiler staging remains owned until the outer supervisor can prove drain", async t => {
  const f = await fixture(t, { compilerFailure: true });
  await assert.rejects(f.buildShellParser(f), { code: "ETIMEDOUT" });
  const work = await fs.readdir(join(f.scratchPath, "tmp"));
  assert.equal(work.length, 1);
  assert.match(work[0], /^shell-parser-/);
  assert.ok((await readFile(join(f.scratchPath, "tmp", work[0], "code/main.go"))).length > 0);
  await assert.rejects(readFile(f.outputPath), { code: "ENOENT" });
});
