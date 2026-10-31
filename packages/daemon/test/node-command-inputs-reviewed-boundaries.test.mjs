import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { captureNodeCommandInputs } from "../dist/runtime/sandbox/node-command-inputs.js";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";

const ref = path => ({ path, sourceRefs: [{ itemId: "user", quote: path }] });
const scope = { kind: "node_module_closure_v1", projectRoot: "project",
  sourceRefs: [{ itemId: "user", quote: "项目目录 project", actorType: "local_user" }] };
const captured = text => { const bytes = Buffer.from(text); return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; };
const request = (files, extras = {}) => ({ inputRefs: [ref("project/cli.js")], commandInputScope: scope,
  hasOptionalInput: path => Object.hasOwn(files, path),
  capture: async path => { assert.ok(Object.hasOwn(files, path), path); return captured(files[path]); }, ...extras });

test("review: a command's output-directory argument cannot become dependency-scope authority", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-project-scope-argument-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const body = "Engineer 运行 node project/cli.js --output project";
  const bound = bindChannelOperationPlan({ sourceItemId: "user", sourceText: body, workspaceCwd: cwd,
    participants: [{ id: "engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["bash"] }],
    candidate: { schemaVersion: 2, operations: [{ id: "cli", kind: "run_command", targetKind: "command", required: true,
      dependsOn: [], owner: { participantId: "engineer", sourceQuote: "Engineer" }, sourceQuote: body,
      command: { text: "node project/cli.js --output project", sourceQuote: "node project/cli.js --output project" },
      inputs: [ref("project/cli.js")].map(({ path }) => ({ path, sourceQuote: path })),
      projectInputRoot: { path: "project", sourceQuote: "project" } }] } });
  assert.equal(bound.status, "clarify", JSON.stringify(bound));
});

test("review: a forged runtime scope is rejected before any capture or metadata probe", async () => {
  let calls = 0;
  for (const forged of [{ ...scope, kind: "forged_scope" }, { ...scope, sourceRefs: [{ itemId: "assistant", quote: "project", actorType: "teammate" }] },
    { ...scope, projectRoot: "../outside" }, { ...scope, verified: true }]) {
    await assert.rejects(captureNodeCommandInputs(request({}, { commandInputScope: forged,
      hasOptionalInput() { calls++; return true; }, capture: async () => { calls++; return captured("export const n=1"); } })),
    /restricted_command_dependency_scope_invalid/);
  }
  assert.equal(calls, 0);
});

test("review: .js without an authorized package boundary refuses rather than changing ancestor type", async () => {
  await assert.rejects(captureNodeCommandInputs(request({ "project/cli.js": "console.log(typeof require)" })),
    /restricted_command_dependency_package_boundary_required/);
});

test("review: a nearer package boundary seals .js without reading above it", async () => {
  const seen = [], files = { "project/sub/cli.js": "export const n=1", "project/sub/package.json": '{"type":"module"}' };
  const result = await captureNodeCommandInputs(request(files, { inputRefs: [ref("project/sub/cli.js")],
    hasOptionalInput(path) { seen.push(path); return Object.hasOwn(files, path); } }));
  assert.equal(result.length, 2);
  assert.deepEqual(seen, ["project/sub/package.json"]);
});

test("review: absent metadata does not reject an exactly full file budget", async () => {
  const files = { "project/sub/cli.mjs": "export const n=1", "project/package.json": '{}' };
  const result = await captureNodeCommandInputs(request(files, { maxFiles: 2,
    inputRefs: [ref("project/sub/cli.mjs"), ref("project/package.json")] }));
  assert.equal(result.length, 2);
});

test("review: existing extra metadata at a full budget is refused before reading its bytes", async () => {
  let extraCapture = false;
  const files = { "project/cli.mjs": "export const n=1", "project/package.json": '{}' };
  await assert.rejects(captureNodeCommandInputs(request(files, { maxFiles: 1, inputRefs: [ref("project/cli.mjs")],
    capture: async path => { if (path.endsWith("package.json")) extraCapture = true; return captured(files[path]); } })),
  /restricted_command_input_budget_exceeded/);
  assert.equal(extraCapture, false);
});

test("review: 64MiB aggregate limit includes all direct inputs and prevents the next capture", async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024), sha256 = createHash("sha256").update(bytes).digest("hex");
  let calls = 0;
  await assert.rejects(captureNodeCommandInputs({ inputRefs: Array.from({ length: 5 }, (_, index) => ref(`data-${index}.bin`)),
    hasOptionalInput() { throw Error("not a module"); }, capture: async (_path, maxBytes) => {
      calls++; assert.equal(maxBytes, bytes.length); return { bytes, sha256 };
    } }), /restricted_command_input_budget_exceeded/);
  assert.equal(calls, 4);
});

test("review: missing package metadata probes have their own global bound", async () => {
  const refs = Array.from({ length: 33 }, (_, index) => ref(`project/group${index}/${"sub/".repeat(64)}cli.mjs`));
  let probes = 0;
  await assert.rejects(captureNodeCommandInputs({ inputRefs: refs, commandInputScope: scope,
    hasOptionalInput(path) { probes++; return path === "project/package.json"; },
    capture: async path => captured(path.endsWith("package.json") ? '{}' : 'export const n=1;') }),
  /restricted_command_dependency_probe_budget_exceeded/);
  assert.ok(probes <= 2048);
});
