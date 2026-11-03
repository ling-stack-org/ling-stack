import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const minimumNodeVersion = manifest.engines.node.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];

function assertNodeSetupVersions(workflow, name) {
  let checked = 0;
  // Keep each pin inside its own block-style step, not a later step or job.
  for (const [, indent, body] of workflow.matchAll(/^( *)- ([^\n]*(?:\n(?:\1 {2}[^\n]*|[ \t]*$))*)/gmu)) {
    const step = body.replace(new RegExp(`^ {${indent.length + 2}}`, "gmu"), "");
    if (!/^uses: ["']?actions\/setup-node@/mu.test(step)) continue;
    const inputs = /^with: *\n((?: {2}[^\n]*(?:\n|$)|[ \t]*\n)*)/mu.exec(step)?.[1] ?? "";
    const versions = [...inputs.matchAll(/^ {2}node-version: (["']?)([^"'\s]+)\1 *(?:#.*)?$/gmu)]
      .map(match => match[2]);
    assert.deepEqual(versions, [minimumNodeVersion], `${name}: setup-node step ${checked + 1} must pin the runtime floor`);
    checked++;
  }
  const references = [...workflow.matchAll(/\buses: *["']?actions\/setup-node@/gu)].length;
  assert.equal(checked, references, `${name}: every setup-node reference must be checked as a step`);
  return checked;
}

// Value: protects=the documented minimum runtime supports actual Host transaction fences and source imports;
// fails_when=CI or the product promises a Node release without these required APIs;
// why_new=CI previously pinned 22.15 while local validation used 22.22.1; seam=none
test("product runtime floor and every CI Node setup share the validated baseline", () => {
  assert.equal(manifest.engines.node, ">=22.22.1");
  const directory = new URL(".github/workflows/", root);
  const workflows = readdirSync(directory).filter(name => /\.ya?ml$/u.test(name));
  assert.ok(workflows.length > 0, "CI workflows must exist");
  let checked = 0;
  for (const name of workflows) {
    checked += assertNodeSetupVersions(readFileSync(new URL(name, directory), "utf8"), name);
  }
  assert.ok(checked > 0, "CI must explicitly pin a Node runtime");
});

function setupStep(version) {
  return `      - uses: actions/setup-node@pinned\n        with:\n          cache: pnpm\n${version === undefined ? "" : `          node-version: ${version}\n`}`;
}

test("baseline checks named and unnamed setup-node steps with quoted or unquoted pins", () => {
  const workflow = setupStep(minimumNodeVersion)
    + `      - name: Set up Node\n        with:\n          node-version: '${minimumNodeVersion}'\n        uses: actions/setup-node@pinned\n`
    + `  another-job:\n    steps:\n${setupStep(`"${minimumNodeVersion}"`)}`;
  assert.equal(assertNodeSetupVersions(workflow, "fixture"), 3);
});

for (const version of [undefined, "22.15.0", "22", "${{ matrix.node }}"]) {
  test(`baseline rejects a setup-node step with ${version ?? "no node-version"}`, () => {
    const workflow = setupStep(version) + setupStep(minimumNodeVersion);
    assert.throws(() => assertNodeSetupVersions(workflow, "fixture"), /must pin the runtime floor/u);
  });
}

test("baseline rejects a pin outside setup-node inputs or in an unsupported step shape", () => {
  const misplaced = setupStep(undefined) + `        env:\n          node-version: ${minimumNodeVersion}\n`;
  assert.throws(() => assertNodeSetupVersions(misplaced, "fixture"), /must pin the runtime floor/u);
  const inline = `      - { uses: actions/setup-node@pinned, with: { node-version: ${minimumNodeVersion} } }\n`;
  assert.throws(() => assertNodeSetupVersions(inline, "fixture"), /every setup-node reference/u);
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
