import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { access, writeFile, readFile, link, mkdir, symlink } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import test from "node:test";
import { NativeRestrictedCommandRuntime } from "../../../packages/daemon/dist/runtime/sandbox/restricted-command-runtime.js";
import { createRestrictedCommandFixture } from "../../../packages/daemon/test/support/restricted-command-fixture.mjs";
import { digestElectronNodeResource, ELECTRON_NODE_RESOURCE_PATHS } from "../../../packages/daemon/dist/runtime/sandbox/electron-node-resources.js";

const helperPath = process.argv[2];
assert.equal(process.platform, "darwin"); assert.ok(helperPath && isAbsolute(helperPath));
const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
const electronPath = process.argv[3];
const executable = pin(electronPath ?? process.execPath);
if (electronPath) {
  assert.ok(isAbsolute(electronPath));
  executable.runtime = { kind: "electron_node_v1", resources: ELECTRON_NODE_RESOURCE_PATHS.map(relativePath =>
    ({ relativePath, sha256: digestElectronNodeResource(join(dirname(dirname(executable.path)), relativePath)) })) };
}
const config = { inputHelper: { ...pin(helperPath), version: "0.1.0-dev.0" }, executables: { node: executable } };
const runtime = () => new NativeRestrictedCommandRuntime(config);
const ref = path => ({ path, sourceRefs: [{ itemId: "source", quote: "Explicit operation fixture" }] });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = code => "node -e " + shellQuote(code);
const outcome = reply => {
  assert.equal(reply.approved, true, JSON.stringify(reply));
  assert.ok(reply.handledResult?.details?.unifiedExec, JSON.stringify(reply));
  return reply.handledResult.details.unifiedExec;
};
const events = f => f.store.listEvents(f.run.id, { limit: 1000 });
const projectScope = { kind: "node_module_closure_v1", projectRoot: "project",
  sourceRefs: [{ itemId: "source", quote: "Project dependencies in project", actorType: "local_user" }] };

test("C01 scoped CLI stages local imports and package metadata, but never unrelated origin files", async t => {
  const f = await createRestrictedCommandFixture(t, "node project/cli.js data.csv", [ref("project/cli.js"), ref("data.csv")], projectScope);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/package.json"), '{"type":"module"}');
  const ledger = "export const sum = rows => rows.reduce((n,v)=>n+Number(v),0);";
  await writeFile(join(f.cwd, "project/ledger.js"), ledger);
  await writeFile(join(f.cwd, "data.csv"), "3000\n7000");
  await writeFile(join(f.cwd, "project/private.js"), "must not stage");
  await writeFile(join(f.cwd, "project/cli.js"), `import {sum} from './ledger.js';import fs from 'node:fs';
    console.log(sum(fs.readFileSync(process.argv[2],'utf8').split('\\n')));
    if(fs.existsSync('project/private.js'))throw Error('unrelated source copied');
    try{fs.readFileSync(${JSON.stringify(join(f.cwd, "project/private.js"))});throw Error('origin leaked')}
    catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('origin:denied')}`);
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.stdout.preview, "10000\norigin:denied\n");
  assert.deepEqual(result.isolation.inputs.map(file => file.path).sort(), ["data.csv", "project/cli.js", "project/ledger.js", "project/package.json"]);
  const dependency = result.isolation.inputs.find(file => file.path === "project/ledger.js");
  assert.equal(dependency.sha256, createHash("sha256").update(ledger).digest("hex"));
  assert.equal(dependency.derivation.parentPath, "project/cli.js");
  assert.equal(dependency.derivation.parentSha256, result.isolation.inputs.find(file => file.path === "project/cli.js").sha256);
  assert.equal(dependency.derivation.projectRoot, "project");
  const artifact = f.store.listArtifacts(f.run.id).find(item => item.id === result.artifacts[0].artifactId);
  assert.match(await readFile(join(f.store.paths.artifactsDir, artifact.path), "utf8"), /node_module_dependency_v1/u);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("an old explicit-only CLI does not gain project scope; missing dependency is not_started", async t => {
  const f = await createRestrictedCommandFixture(t, "node project/cli.mjs", [ref("project/cli.mjs")]);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/cli.mjs"), "import './ledger.mjs'; console.log('must-not-run');");
  await writeFile(join(f.cwd, "project/ledger.mjs"), "export const n=1");
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed");
  assert.match(result.stderr.preview, /restricted_command_dependency_scope_required/);
  assert.equal(result.stdout.preview, "");
  assert.equal(events(f).find(event => event.type === "host_command_settled").data.outcome, "not_started");
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("a derived hardlink is rejected by the same native boundary before command spawn", async t => {
  const f = await createRestrictedCommandFixture(t, "node project/cli.mjs", [ref("project/cli.mjs")], projectScope);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/cli.mjs"), "import './ledger.mjs'; console.log('must-not-run');");
  await writeFile(join(f.root, "outside.mjs"), "export const privateValue=1;");
  await link(join(f.root, "outside.mjs"), join(f.cwd, "project/ledger.mjs"));
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /hardlink_rejected/);
  assert.equal(events(f).find(event => event.type === "host_command_settled").data.outcome, "not_started");
});

test("a derived symlink never follows an outside module into the execution copy", async t => {
  const f = await createRestrictedCommandFixture(t, "node project/cli.mjs", [ref("project/cli.mjs")], projectScope);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "project/cli.mjs"), "import './ledger.mjs'; console.log('must-not-run');");
  await writeFile(join(f.root, "private.mjs"), "export const privateValue=1;");
  await symlink(join(f.root, "private.mjs"), join(f.cwd, "project/ledger.mjs"));
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /native_input/);
  assert.equal(result.stdout.preview, "");
  assert.equal(events(f).find(event => event.type === "host_command_settled").data.outcome, "not_started");
});

test("an open .js package boundary does not silently change an origin ESM script into CJS", async t => {
  const f = await createRestrictedCommandFixture(t, "node project/cli.js", [ref("project/cli.js")], projectScope);
  await mkdir(join(f.cwd, "project"));
  await writeFile(join(f.cwd, "package.json"), '{"type":"module"}');
  await writeFile(join(f.cwd, "project/cli.js"), "console.log(typeof require);");
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed");
  assert.match(result.stderr.preview, /restricted_command_dependency_package_boundary_required/);
  assert.equal(result.stdout.preview, "");
  assert.equal(events(f).find(event => event.type === "host_command_settled").data.outcome, "not_started");
});

test("restricted backend is not approval, and an unapproved internal command never starts", async t => {
  const f = await createRestrictedCommandFixture(t, nodeCommand("console.log('approved-only')"));
  const result = await f.execute({ restrictedCommandRuntime: runtime() });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /restricted_command_approval_required/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("real approval executes a declared Node input in a read-only copy, without inherited environment or network", async t => {
  t.diagnostic(electronPath ? "Runtime: App-bundled Electron in fixed Node mode" : "Runtime: standalone Node");
  const code = [
    "const fs=require('node:fs');",
    "console.log(require('./proof.cjs').formatProof('7319'));",
    "if(process.env.LING_STACK_HOME)throw Error('Host environment leaked');",
    "try{fs.writeFileSync('proof.cjs','overwrite');throw Error('copy writable')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}",
    "const net=require('node:net');const s=net.connect(9,'127.0.0.1');",
    "s.on('connect',()=>{throw Error('network allowed')});s.on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('network:denied')});",
  ].join("");
  const f = await createRestrictedCommandFixture(t, "node driver.cjs", [ref("driver.cjs"), ref("proof.cjs")]);
  await writeFile(join(f.cwd, "driver.cjs"), code);
  const content = "exports.formatProof = value => 'proof:' + value;";
  await writeFile(join(f.cwd, "proof.cjs"), content);
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.stdout.preview, "proof:7319\nnetwork:denied\n");
  if (electronPath) assert.equal(result.isolation.actualCommand.argv[0], "[REDACTED]");
  assert.equal(result.isolation.backend, "macos_seatbelt");
  assert.notEqual(result.isolation.executionCwd, f.cwd);
  assert.equal(result.isolation.inputs.find(input => input.path === "proof.cjs").sha256, createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(result.isolation.inputs[0].sourceItemIds, ["source"]);
  assert.equal(await readFile(join(f.cwd, "proof.cjs"), "utf8"), content);
  await assert.rejects(access(result.isolation.executionCwd), { code: "ENOENT" });
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("a declared file cannot access undeclared origin content through an absolute path", async t => {
  const f = await createRestrictedCommandFixture(t, "node proof.cjs", [ref("proof.cjs")]);
  await writeFile(join(f.cwd, "private.txt"), "must-not-read");
  await writeFile(join(f.cwd, "proof.cjs"), "const fs=require('node:fs');try{fs.readFileSync(" +
    JSON.stringify(join(f.cwd, "private.txt")) + ");throw Error('origin leaked')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('origin:denied')}");
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "succeeded", JSON.stringify(result)); assert.equal(result.stdout.preview, "origin:denied\n");
});

test("missing input settles preparation as not_started, without a permanent workspace reservation", async t => {
  const f = await createRestrictedCommandFixture(t, "node missing.cjs", [ref("missing.cjs")]);
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /native_input/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
  const settlement = events(f).find(event => event.type === "host_command_settled");
  assert.equal(settlement.data.outcome, "not_started");
});

test("real native capture rejects a hardlink before copying bytes or starting the command", async t => {
  const f = await createRestrictedCommandFixture(t, "node alias.cjs", [ref("alias.cjs")]);
  await writeFile(join(f.root, "outside.cjs"), "throw Error('private')");
  await link(join(f.root, "outside.cjs"), join(f.cwd, "alias.cjs"));
  const result = outcome(await f.approve(runtime()));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /hardlink_rejected/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("policy change during approval cannot authorize the previously prepared source", async t => {
  const f = await createRestrictedCommandFixture(t, nodeCommand("console.log('must-not-run')"));
  const reply = await f.approve(runtime(), () => {
    f.store.updateApprovalPolicy({ toolDecisions: { bash: "deny" } }, new Date(Date.now() + 1).toISOString());
  });
  const result = outcome(reply);
  assert.equal(result.denied, true); assert.match(result.reason, /restricted_command_policy_changed/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("owner replacement after input preparation is rechecked in the atomic launch callback", async t => {
  const f = await createRestrictedCommandFixture(t, nodeCommand("console.log('must-not-run')"));
  const backend = runtime(), original = backend.prepare.bind(backend);
  let prepared;
  backend.prepare = async input => {
    prepared = await original(input);
    f.store.updateChannelWorkflowStep(f.basis.step.id, { runId: null }, new Date().toISOString());
    return prepared;
  };
  const result = outcome(await f.approve(backend));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /operation_binding_owner_mismatch/);
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
  await assert.rejects(access(prepared.evidence.executionCwd), { code: "ENOENT" });
});

test("cancellation between preparation and launch does not execute or leave a prepared journal", async t => {
  const f = await createRestrictedCommandFixture(t, nodeCommand("console.log('must-not-run')"));
  const backend = runtime(), original = backend.prepare.bind(backend), controller = new AbortController();
  backend.prepare = async input => { const result = await original(input); controller.abort(); return result; };
  await assert.rejects(f.approve(backend, () => {}, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.store.listHostCommandWriteBlockers(f.cwd).length, 0);
});

test("runtime executables nested under a ..named workspace directory are not outside the workspace", async t => {
  const f = await createRestrictedCommandFixture(t, "node --version");
  const directory = join(f.cwd, "..tools"); await mkdir(directory);
  const executable = join(directory, "node");
  await writeFile(executable, readFileSync(config.executables.node.path), { mode: 0o700 });
  const backend = new NativeRestrictedCommandRuntime({ ...config, executables: { node: pin(executable) } });
  const result = outcome(await f.approve(backend));
  assert.equal(result.status, "failed"); assert.match(result.stderr.preview, /restricted_command_runtime_inside_workspace/);
});

test("actual command arguments are redacted in handled results and persisted isolation evidence", async t => {
  const secret = "fixture-sensitive-command-arg";
  const f = await createRestrictedCommandFixture(t, nodeCommand("console.log(" + JSON.stringify(secret) + ")"));
  const result = outcome(await f.approve(runtime(), () => {}, { extraSecrets: [secret] }));
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes(secret), false);
  const artifact = f.store.listArtifacts(f.run.id).find(item => item.id === result.artifacts[0].artifactId);
  assert.equal((await readFile(join(f.store.paths.artifactsDir, artifact.path), "utf8")).includes(secret), false);
});
