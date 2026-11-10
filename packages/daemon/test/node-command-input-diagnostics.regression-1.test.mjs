import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureNodeCommandInputs, NodeCommandInputPreparationError } from "../dist/runtime/sandbox/node-command-inputs.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";

// Found by /qa on 2026-10-27
// Report: output/e6-20260928/channel-policy-command-inputs-implementation-20261027.md
const ref = { path: "project/cli.mjs", sourceRefs: [{ itemId: "source", quote: "Explicit operation fixture" }] };
const explicitScope = { kind: "node_module_closure_v1", projectRoot: "project",
  sourceRefs: [{ itemId: "source", quote: "项目目录 project", actorType: "local_user" }] };

// Diagnostic transport fixture: the real parser throws at the native preparation
// boundary, then real temporary Host journal/result/artifact code records it.
// This does not claim native-helper, subprocess, or packaged GUI coverage.
async function failPreparation(t, prepare, scope) {
  const f = await createRestrictedCommandFixture(t, "node project/cli.mjs", [ref], scope);
  const runtime = new NativeRestrictedCommandRuntime({ inputHelper: {}, executables: {} });
  runtime.assertAvailable = () => ({ kind: "argv", argv: ["node", "project/cli.mjs"] });
  let preparationCount = 0;
  runtime.prepare = async input => {
    preparationCount++;
    await prepare(input);
    throw new Error("fixture_expected_preparation_error");
  };
  const decision = await f.approve(runtime);
  assert.ok(decision.handledResult, `missing execution result: ${JSON.stringify(decision)}`);
  const result = decision.handledResult;
  assert.equal(preparationCount, 1, `failure must pass through the preparation boundary exactly once: ${result.content[0].text}`);
  assert.equal(result.isError, true);
  const detail = result.details.unifiedExec;
  assert.equal(detail.status, "failed");
  assert.equal(detail.exitCode, undefined);
  const events = f.store.listEvents(f.run.id);
  assert.equal(events.filter(event => event.type === "host_command_prepared").length, 1);
  const settled = events.filter(event => event.type === "host_command_settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].data.outcome, "not_started");
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
  const diagnostic = detail.stderr.preview;
  assert.equal(typeof diagnostic, "string");
  assert.ok(result.content[0].text.includes(diagnostic), "model-visible output must carry the same diagnostic");
  for (const role of ["stderr", "result"]) {
    const summary = detail.artifacts.find(artifact => artifact.role === role);
    assert.ok(summary, `missing ${role} artifact`);
    const artifact = f.store.getArtifact(summary.artifactId);
    const text = await readFile(join(f.store.paths.artifactsDir, artifact.path), "utf8");
    assert.equal(role === "result" ? JSON.parse(text).stderr.preview : text, diagnostic);
  }
  return { diagnostic, result };
}

const captureFailure = (files) => (input) => captureNodeCommandInputs({
  inputRefs: input.inputRefs, commandInputScope: input.commandInputScope,
  hasOptionalInput: path => Object.hasOwn(files, path),
  async capture(path) {
    assert.ok(Object.hasOwn(files, path), `unexpected input capture: ${path}`);
    const bytes = Buffer.from(files[path]);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  },
});

test("missing Node dependency scope explains the safe path throughout the durable failure chain", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, captureFailure({ "project/cli.mjs": "import './dep.mjs';" }));
  assert.match(diagnostic, /restricted_command_dependency_scope_required/u);
  assert.match(diagnostic, /"project\/dep\.mjs"/u);
  assert.match(diagnostic, /accepted dependency-read scope/u);
  assert.match(diagnostic, /Read permission.*before this operation can continue/u);
});

test("outside-scope Node dependency explains its safe relative path without changing the original operation", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, captureFailure({ "project/cli.mjs": "import '../outside.mjs';" }), explicitScope);
  assert.match(diagnostic, /restricted_command_dependency_outside_scope/u);
  assert.match(diagnostic, /"outside\.mjs"/u);
  assert.match(diagnostic, /outside the accepted read scope/u);
  assert.match(diagnostic, /Read permission.*before this operation can continue/u);
});

test("unsupported Node resolution is a capability limit, not a request for broader authorization", { timeout: 10000 }, async t => {
  const secret = "sensitive-query-value";
  const { diagnostic, result } = await failPreparation(t, captureFailure({
    "project/cli.mjs": `import 'file:///private/input.mjs?credential=${secret}';`,
  }));
  assert.match(diagnostic, /restricted_command_dependency_unsupported/u);
  assert.match(diagnostic, /not supported/u);
  assert.match(diagnostic, /capability limit/u);
  assert.match(diagnostic, /broader authorization cannot resolve/u);
  assert.doesNotMatch(diagnostic, /Read permission/u);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-query-value|file:\/\/\/private/u);
});

test("escaped and protected dependency paths are never added to user-visible diagnostics", { timeout: 15000 }, async t => {
  for (const specifier of ["../../escape.mjs", "./.git/private.mjs"]) {
    const { diagnostic, result } = await failPreparation(t, captureFailure({
      "project/cli.mjs": `import ${JSON.stringify(specifier)};`,
    }), explicitScope);
    assert.match(diagnostic, /restricted_command_dependency_outside_scope/u);
    assert.match(diagnostic, /outside the accepted read scope/u);
    assert.doesNotMatch(JSON.stringify(result), /escape\.mjs|\.git|private\.mjs/u);
  }
});

test("changed dependency policy requires revalidation rather than silently continuing", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, () => {
    throw Object.assign(new Error("restricted_command_input_policy_changed"), {
      code: "restricted_command_input_policy_changed", path: "/private/untrusted", cause: new Error("private cause"),
    });
  });
  assert.match(diagnostic, /restricted_command_input_policy_changed/u);
  assert.match(diagnostic, /permissions changed/u);
  assert.match(diagnostic, /Revalidate the original operation/u);
  assert.doesNotMatch(diagnostic, /private/u);
});

test("effective read denial distinguishes dependency permission from command approval", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, () => {
    throw Object.assign(new Error("restricted_command_input_read_not_allowed"), {
      code: "restricted_command_input_read_not_allowed", path: "/private/untrusted",
    });
  });
  assert.match(diagnostic, /restricted_command_input_read_not_allowed/u);
  assert.match(diagnostic, /read=allow/u);
  assert.match(diagnostic, /Command approval does not grant dependency-read permission/u);
  assert.doesNotMatch(diagnostic, /private/u);
});

test("untrusted structured lookalikes cannot append arbitrary diagnostic fields", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, () => {
    throw Object.assign(new Error("opaque preparation failure"), {
      name: "NodeCommandInputPreparationError", code: "restricted_command_dependency_scope_required",
      path: "project/untrusted.mjs", source: "private source", specifier: "file:///private/source",
    });
  });
  assert.equal(diagnostic, "opaque preparation failure");
});

test("trusted diagnostics still reject a modified unsafe or oversized path", { timeout: 15000 }, async t => {
  for (const path of ["../private.mjs", "project/.secret.mjs", "p/" + "x".repeat(4096)]) {
    const { diagnostic } = await failPreparation(t, () => {
      const error = new NodeCommandInputPreparationError("restricted_command_dependency_scope_required");
      Object.defineProperty(error, "path", { value: path });
      throw error;
    });
    assert.match(diagnostic, /accepted dependency-read scope/u);
    assert.ok(!diagnostic.includes(path));
  }
});

test("unknown preparation errors preserve existing formatting without inspecting extra fields", { timeout: 10000 }, async t => {
  const { diagnostic } = await failPreparation(t, () => {
    throw Object.assign(new Error("existing opaque error"), { code: "unknown_code", path: "private source path" });
  });
  assert.equal(diagnostic, "existing opaque error");
});
