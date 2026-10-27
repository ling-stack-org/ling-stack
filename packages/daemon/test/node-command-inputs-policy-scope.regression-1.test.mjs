import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureNodeCommandInputs } from "../dist/runtime/sandbox/node-command-inputs.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = path => ({ path, sourceRefs: [{ itemId: "direct-input", quote: path, actorType: "local_user" }] });
const authority = () => ({ kind: "channel_effective_policy_v1", channelId: "channel", workspaceId: "workspace",
  participantId: "engineer", operationId: "node-run", sourceItemId: "request-user", sourceRevision: 3,
  workspaceCwd: "/verified/workspace", executionCwd: "/verified/workspace",
  workspaceRootIdentity: { device: "1", inode: "2" }, executionRootIdentity: { device: "1", inode: "2" },
  channelUpdatedAt: "2026-10-27T00:00:00.000Z", workspacePolicyUpdatedAt: "2026-10-27T00:00:00.000Z",
  policyFingerprint: "a".repeat(64) });
const policyScope = () => ({ kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [], policyAuthority: authority() });
const explicitScope = { kind: "node_module_closure_v1", projectRoot: "project",
  sourceRefs: [{ itemId: "explicit-root-user", quote: "项目目录 project", actorType: "local_user" }] };

async function capture(files, options = {}) {
  const captures = [], probes = [];
  const result = await captureNodeCommandInputs({ inputRefs: options.inputRefs ?? [ref("cli.js")],
    commandInputScope: Object.hasOwn(options, "scope") ? options.scope : policyScope(),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    ...(options.analyzeModules === undefined ? {} : { analyzeModules: options.analyzeModules }),
    hasOptionalInput(path) { probes.push(path); options.onProbe?.(path); return Object.hasOwn(files, path); },
    async capture(path, maxBytes) {
      captures.push(path); options.onCapture?.(path);
      assert.ok(Object.hasOwn(files, path), `fixture_missing:${path}`);
      const bytes = Buffer.isBuffer(files[path]) ? files[path] : Buffer.from(files[path]);
      if (bytes.length > maxBytes) throw Error("native_input_budget_exceeded");
      return { bytes, sha256: digest(bytes) };
    } });
  return { result, captures, probes };
}

test("policy root captures transitive inputs and canonical root metadata without a fake user quote", async () => {
  const files = { "cli.js": "import './lib/first.mjs';", "package.json": '{"type":"module"}',
    "lib/first.mjs": "export {value} from './second.cjs';", "lib/second.cjs": "exports.value=require('../value.json');",
    "value.json": '{"n":1}', "private.txt": "not an input", "lib/unrelated.js": "not an input" };
  const { result, captures, probes } = await capture(files);
  assert.deepEqual(result.map(file => file.path).sort(), ["cli.js", "lib/first.mjs", "lib/second.cjs", "package.json", "value.json"]);
  assert.equal(captures.includes("private.txt"), false); assert.equal(captures.includes("lib/unrelated.js"), false);
  assert.equal([...captures, ...probes].some(path => path.startsWith("./") || path.startsWith("../")), false);
  assert.deepEqual(probes, ["package.json", "lib/package.json"]);
  assert.deepEqual(result.find(file => file.path === "cli.js").sourceItemIds, ["direct-input"]);
  for (const file of result.filter(file => file.derivation)) {
    assert.deepEqual(file.sourceItemIds, ["request-user"]);
    assert.deepEqual(file.derivation.policyAuthority, authority());
    assert.equal(file.derivation.projectRoot, ".");
    assert.equal(Object.hasOwn(file.derivation.policyAuthority, "quote"), false);
  }
  assert.deepEqual(result.find(file => file.path === "package.json").derivation, {
    kind: "node_package_metadata_v1", parentPath: "cli.js", parentSha256: digest(Buffer.from(files["cli.js"])),
    projectRoot: ".", policyAuthority: authority(),
  });
});

test("policy scope is snapshotted before awaited capture and cannot acquire later authority edits", async () => {
  const scope = policyScope(), expected = structuredClone(scope.policyAuthority);
  const { result } = await capture({ "cli.js": "import './dep.mjs'", "dep.mjs": "export const n=1", "package.json": '{}' }, {
    scope, onCapture(path) { if (path === "cli.js") { scope.policyAuthority.sourceItemId = "later"; scope.policyAuthority.policyFingerprint = "b".repeat(64); } },
  });
  const dependency = result.find(file => file.path === "dep.mjs");
  assert.deepEqual(dependency.sourceItemIds, ["request-user"]); assert.deepEqual(dependency.derivation.policyAuthority, expected);
});

test("root .js requires a package boundary and probes only the canonical root metadata", async () => {
  const probes = [];
  await assert.rejects(capture({ "cli.js": "console.log(typeof require)" }, { onProbe: path => probes.push(path) }),
    /restricted_command_dependency_package_boundary_required/u);
  assert.deepEqual(probes, ["package.json"]);
});

test("nearer package metadata seals the root-policy .js boundary without probing ancestors", async () => {
  const { result, probes } = await capture({ "sub/cli.js": "export const n=1", "sub/package.json": '{"type":"module"}',
    "package.json": "not needed" }, { inputRefs: [ref("sub/cli.js")] });
  assert.deepEqual(probes, ["sub/package.json"]); assert.deepEqual(result.map(file => file.path), ["sub/cli.js", "sub/package.json"]);
});

test("a normalized parent import may stay inside the verified workspace root", async () => {
  const { result } = await capture({ "sub/cli.mjs": "import '../dep.mjs'", "dep.mjs": "export const n=1" },
    { inputRefs: [ref("sub/cli.mjs")] });
  assert.ok(result.some(file => file.path === "dep.mjs"));
});

for (const specifier of ["../escape.mjs", "./sub/../../escape.mjs", "./.ling/private.mjs", "./.git/config.mjs", "./hidden/.secret.mjs",
  "/escape.mjs", "file:///escape.mjs", "./dep.mjs?query", "./%2e%2e/escape.mjs"]) {
  test(`policy root rejects a hidden, escaped or unsupported dependency before reading it: ${specifier}`, async () => {
    const seen = [];
    await assert.rejects(capture({ "cli.mjs": `import ${JSON.stringify(specifier)}` }, { inputRefs: [ref("cli.mjs")],
      onCapture: path => seen.push(path) }), /restricted_command_dependency_(?:outside_scope|unsupported)/u);
    assert.deepEqual(seen, ["cli.mjs"]);
  });
}

for (const code of ["import(process.argv[2])", "require(process.argv[2])", "import 'some-package'", "require('./extensionless')"]) {
  test(`policy scope does not add unsupported npm or dynamic resolution: ${code}`, async () => {
    await assert.rejects(capture({ "cli.mjs": code }, { inputRefs: [ref("cli.mjs")] }), /restricted_command_dependency_unsupported/u);
  });
}

test("policy scope does not infer fs.readFile inputs or walk the workspace", async () => {
  const { captures, probes } = await capture({ "cli.mjs": "import fs from 'node:fs';fs.readFileSync('private.txt');",
    "private.txt": "must not be read", "other/unused.mjs": "must not be read" }, { inputRefs: [ref("cli.mjs")] });
  assert.deepEqual(captures, ["cli.mjs"]); assert.deepEqual(probes, ["package.json"]);
});

test("file budgets cover policy metadata and dependencies before reading an extra input", async () => {
  const seen = [];
  await assert.rejects(capture({ "cli.js": "import './dep.mjs'", "package.json": '{}', "dep.mjs": "export const n=1" },
    { maxFiles: 2, onCapture: path => seen.push(path) }), /restricted_command_input_budget_exceeded/u);
  assert.deepEqual(seen, ["cli.js", "package.json"]);
});

test("absent optional root metadata does not consume a full file budget", async () => {
  const { result, probes } = await capture({ "cli.mjs": "export const n=1" }, { inputRefs: [ref("cli.mjs")], maxFiles: 1 });
  assert.equal(result.length, 1); assert.deepEqual(probes, ["package.json"]);
});

test("missing policy metadata probes keep the existing global budget", async () => {
  const paths = Array.from({ length: 33 }, (_, index) => `group${index}/${"sub/".repeat(64)}cli.mjs`);
  let probes = 0;
  await assert.rejects(capture(Object.fromEntries(paths.map(path => [path, "export const n=1"])),
    { inputRefs: paths.map(ref), onProbe() { probes++; } }), /restricted_command_dependency_probe_budget_exceeded/u);
  assert.equal(probes, 2048);
});

test("the dependency source-byte budget remains enforced under policy scope", async () => {
  await assert.rejects(capture({ "cli.mjs": " ".repeat(1024 * 1024 + 1) }, { inputRefs: [ref("cli.mjs")] }),
    /restricted_command_dependency_source_budget_exceeded/u);
});

test("policy metadata parsing and guarded capture errors cannot return partial closures", async () => {
  await assert.rejects(capture({ "cli.js": "export const n=1", "package.json": '{' }), /restricted_command_dependency_package_invalid/u);
  await assert.rejects(capture({ "cli.mjs": "import './dep.mjs'", "dep.mjs": "export const n=1" },
    { inputRefs: [ref("cli.mjs")], onCapture(path) { if (path === "dep.mjs") throw Error("stale_policy_authority"); } }), /stale_policy_authority/u);
});

test("legacy no-scope commands still need explicit local imports and acquire no policy evidence", async () => {
  const files = { "cli.mjs": "import './dep.mjs'", "dep.mjs": "export const n=1" };
  await assert.rejects(capture(files, { scope: undefined, inputRefs: [ref("cli.mjs")] }), /restricted_command_dependency_scope_required/u);
  const { result, probes } = await capture(files, { scope: undefined, inputRefs: [ref("cli.mjs"), ref("dep.mjs")] });
  assert.equal(result.length, 2); assert.deepEqual(probes, []); assert.equal(result.some(file => file.derivation), false);
});

test("legacy explicit-root closures keep their exact local-user provenance and boundary", async () => {
  const { result } = await capture({ "project/cli.js": "import './dep.mjs'", "project/package.json": '{}',
    "project/dep.mjs": "export const n=1" }, { scope: explicitScope, inputRefs: [ref("project/cli.js")] });
  const dependency = result.find(file => file.path === "project/dep.mjs");
  assert.deepEqual(dependency.sourceItemIds, ["explicit-root-user"]);
  assert.deepEqual(dependency.derivation, { kind: "node_module_dependency_v1", parentPath: "project/cli.js",
    parentSha256: digest(Buffer.from("import './dep.mjs'")), projectRoot: "project" });
  await assert.rejects(capture({ "project/cli.mjs": "import '../escape.mjs'" },
    { scope: explicitScope, inputRefs: [ref("project/cli.mjs")] }), /restricted_command_dependency_outside_scope/u);
});

test("scope diagnostics carry only a canonical permitted-to-describe relative dependency path", async () => {
  for (const scenario of [
    { scope: undefined, specifier: "./missing.mjs", code: "restricted_command_dependency_scope_required", path: "project/missing.mjs" },
    { scope: explicitScope, specifier: "../outside.mjs", code: "restricted_command_dependency_outside_scope", path: "outside.mjs" },
    { scope: explicitScope, specifier: "../../escape.mjs", code: "restricted_command_dependency_outside_scope", path: undefined },
    { scope: explicitScope, specifier: "./.git/private.mjs", code: "restricted_command_dependency_outside_scope", path: undefined },
  ]) {
    await assert.rejects(capture({ "project/cli.mjs": `import ${JSON.stringify(scenario.specifier)}` },
      { scope: scenario.scope, inputRefs: [ref("project/cli.mjs")] }), error => {
      assert.equal(error.name, "NodeCommandInputPreparationError");
      assert.equal(error.code, scenario.code); assert.equal(error.message, scenario.code);
      assert.equal(error.path, scenario.path); return true;
    });
  }
});

test("unsupported dependency diagnostics never echo arbitrary specifiers or source", async () => {
  const secret = "sensitive-query-value", specifier = `file:///private/input.mjs?credential=${secret}`;
  await assert.rejects(capture({ "cli.mjs": `import ${JSON.stringify(specifier)}` }, { scope: undefined, inputRefs: [ref("cli.mjs")] }), error => {
    assert.equal(error.name, "NodeCommandInputPreparationError");
    assert.equal(error.code, "restricted_command_dependency_unsupported");
    assert.equal(error.message, error.code); assert.equal(error.path, undefined);
    assert.equal(String(error.stack).includes(secret), false); assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test("malformed policy scopes fail before any probe or capture", async () => {
  const scopes = [
    { ...policyScope(), policyAuthority: { ...authority(), policyFingerprint: "invalid" } },
    { ...policyScope(), projectRoot: "../escape" },
    { ...policyScope(), sourceRefs: explicitScope.sourceRefs },
    { kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [] },
    { ...policyScope(), verified: true },
  ];
  for (const scope of scopes) {
    let calls = 0;
    await assert.rejects(capture({}, { scope, onCapture() { calls++; }, onProbe() { calls++; } }), /restricted_command_dependency_scope_invalid/u);
    assert.equal(calls, 0);
  }
});
