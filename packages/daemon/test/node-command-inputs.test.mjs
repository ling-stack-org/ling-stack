import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureNodeCommandInputs } from "../dist/runtime/sandbox/node-command-inputs.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = path => ({ path, sourceRefs: [{ itemId: "direct", quote: path }] });
const scope = { kind: "node_module_closure_v1", projectRoot: "project",
  sourceRefs: [{ itemId: "scope-user", quote: "项目目录 project", actorType: "local_user" }] };
async function capture(files, refs = [ref("project/cli.js"), ref("data.csv")], options = {}) {
  files["project/package.json"] ??= '{}';
  const calls = [];
  const result = await captureNodeCommandInputs({ inputRefs: refs, commandInputScope: scope, ...options,
    hasOptionalInput: path => Object.hasOwn(files, path),
    capture: async (path, maxBytes, optional) => {
      calls.push(path);
      options.check?.(path);
      if (!Object.hasOwn(files, path)) {
        if (optional) return undefined;
        throw Error("fixture_missing_input");
      }
      const bytes = Buffer.from(files[path]);
      if (bytes.length > maxBytes) throw Error("native_input_budget_exceeded");
      return { bytes, sha256: digest(bytes) };
    } });
  return { result, calls };
}

test("scoped CLI captures the transitive ESM/CJS/JSON closure with parent hashes, not the whole project", async () => {
  const files = { "project/cli.js": "import {sum} from './ledger.js'; console.log(sum());",
    "project/ledger.js": "export {sum} from './sum.cjs';", "project/sum.cjs": "exports.sum=()=>require('./value.json').cents;",
    "project/value.json": '{"cents":10000}', "project/package.json": '{"type":"module"}',
    "data.csv": "amount\n10000", "project/private.js": "must not copy", "private.txt": "must not copy" };
  const { result, calls } = await capture(files);
  assert.deepEqual(result.map(file => file.path).sort(), ["data.csv", "project/cli.js", "project/ledger.js", "project/package.json", "project/sum.cjs", "project/value.json"]);
  assert.equal(calls.includes("project/private.js"), false);
  const ledger = result.find(file => file.path === "project/ledger.js");
  assert.deepEqual(ledger.sourceItemIds, ["scope-user"]);
  assert.deepEqual(ledger.derivation, { kind: "node_module_dependency_v1", parentPath: "project/cli.js",
    parentSha256: digest(Buffer.from(files["project/cli.js"])), projectRoot: "project" });
});

test("cycles, duplicate imports and builtins are bounded and captured once", async () => {
  const { calls } = await capture({ "project/cli.js": "import './a.js';import './a.js';import fs from 'node:fs';",
    "project/a.js": "import './cli.js'; import('node:path');", "data.csv": "data" });
  assert.equal(calls.filter(path => path === "project/cli.js").length, 1);
  assert.equal(calls.filter(path => path === "project/a.js").length, 1);
});

test("an unscoped command never reads undeclared local imports", async () => {
  const files = { "project/cli.js": "import './ledger.js'", "project/ledger.js": "export const n=1", "data.csv": "data" };
  await assert.rejects(capture(files, undefined, { commandInputScope: undefined }), /restricted_command_dependency_scope_required/);
  const { result } = await capture(files, [ref("project/cli.js"), ref("project/ledger.js")], { commandInputScope: undefined });
  assert.equal(result.length, 2);
  assert.equal(result.some(file => file.derivation), false);
});

for (const dependency of ["../private.js", "./.ling/private.js", "./.git/config.js", "/private.js", "file:///private.js"]) {
  test(`out-of-scope dependency is refused before capture: ${dependency}`, async () => {
    const seen = [];
    await assert.rejects(capture({ "project/cli.js": `import ${JSON.stringify(dependency)}`, "data.csv": "data" }, undefined,
      { check: path => seen.push(path) }), /restricted_command_dependency_(?:outside_scope|unsupported)/);
    assert.equal(seen.includes("private.js"), false);
    assert.equal(seen.some(path => path.includes(".ling") || path.includes(".git")), false);
  });
}

for (const code of ["import(process.argv[2])", "require(process.argv[2])", "import x from 'external-package'", "require('./extensionless')"]) {
  test(`unsupported dependency is explicit, not a fallback: ${code}`, async () => {
    await assert.rejects(capture({ "project/cli.js": code, "data.csv": "data" }), /restricted_command_dependency_unsupported/);
  });
}

test("captured source bytes, not a later filesystem read, determine dependency edges", async () => {
  const files = { "project/cli.js": "import './one.js'", "project/one.js": "export const n=1", "data.csv": "data" };
  const { result } = await capture(files, undefined, { check(path) {
    if (path === "data.csv") files["project/cli.js"] = "import './unapproved.js'";
  } });
  assert.equal(result.some(file => file.path.endsWith("one.js")), true);
  assert.equal(result.some(file => file.path.endsWith("unapproved.js")), false);
});

test("capture cancellation/authority errors propagate without returning a partial snapshot", async () => {
  await assert.rejects(capture({ "project/cli.js": "import './ledger.js'", "data.csv": "data" }, undefined,
    { check(path) { if (path.endsWith("ledger.js")) throw Error("stale_run_execution"); } }), /stale_run_execution/);
});

test("file-count and aggregate-byte budgets include direct and derived inputs", async () => {
  const refs = Array.from({ length: 257 }, (_, index) => ref(`data-${index}.csv`));
  await assert.rejects(capture({}, refs), /restricted_command_input_budget_exceeded/);
  const files = { "project/cli.js": "import './ledger.js'", "project/ledger.js": "export const n=1", "data.csv": "data" };
  await assert.rejects(capture(files, undefined, { maxFiles: 2 }), /restricted_command_input_budget_exceeded/);
});
