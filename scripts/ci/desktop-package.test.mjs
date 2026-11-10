import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractedApplicationPath, inventoryApplicationTree } from "../release/desktop-payload.mjs";
import { extractCuaDriverFinalArtifact } from "../../apps/desktop/scripts/cua-driver-signing/final-artifact-extractor.mjs";
import { smokeWindowsInstaller } from "../release/windows-installer-smoke.mjs";
import { collectGstackEvidence } from "../release/collect-gstack-evidence.mjs";
import { prepareBrowserSmokeWorkspace } from "../release/browser-acquisition-smoke.mjs";
import { acquireResourceLease, initResourceWorkspace, managedResourceWrite } from "../gstack/resource-workspace.mjs";

test("browser smoke has a fresh governed workspace when build reports occupy both retained slots", async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "ling-browser-smoke-admission-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const environment = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "package", RUNNER_TEMP: temporary };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const candidateRoot = join(temporary, "gstack-candidate");
  await initResourceWorkspace({ root: candidateRoot, ciEphemeral: true });
  const buildReports = join(candidateRoot, "artifacts/report"); await mkdir(buildReports);
  for (const name of ["shell-parser", "shell-parser.build-provenance.json"]) await writeFile(join(buildReports, name), name);
  const buildLease = await acquireResourceLease(candidateRoot);
  try {
    await assert.rejects(managedResourceWrite(join(buildReports, "browser-smoke"), { kind: "report", env: buildLease.env }), /retention_limit/);
  } finally { await buildLease.release(); }
  const smokeRoot = await prepareBrowserSmokeWorkspace();
  const lease = await acquireResourceLease(smokeRoot);
  try {
    await managedResourceWrite(join(smokeRoot, "artifacts/report/browser-smoke"), { kind: "report", env: lease.env });
    assert.notEqual(smokeRoot, candidateRoot);
    assert.deepEqual((await readdir(buildReports)).sort(), ["shell-parser", "shell-parser.build-provenance.json"]);
  } finally { await lease.release(); }
  await assert.rejects(prepareBrowserSmokeWorkspace(), /EEXIST/);
});

test("package diagnostics preserve fatal status and nested assertion stacks", () => {
  const result = spawnSync(process.execPath, ["--import", new URL("../release/desktop-package-diagnostics.mjs", import.meta.url).href,
    "--eval", 'throw new Error("synthetic_outer", { cause: new Error("synthetic_inner") });'], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const diagnostic = result.stderr.split("\n").find(line => line.startsWith("desktop_package_failure_causes="));
  assert.ok(diagnostic, result.stderr);
  const causes = JSON.parse(diagnostic.slice("desktop_package_failure_causes=".length));
  assert.equal(causes.length, 2);
  assert.match(causes[0], /synthetic_outer/u);
  assert.match(causes[1], /synthetic_inner/u);
});

test("package diagnostics retain aggregate extraction and cleanup failures", () => {
  const result = spawnSync(process.execPath, ["--import", new URL("../release/desktop-package-diagnostics.mjs", import.meta.url).href,
    "--eval", 'throw new AggregateError([new Error("synthetic_attach"), new Error("synthetic_cleanup", { cause: new Error("synthetic_command") })], "synthetic_aggregate");'], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const diagnostic = result.stderr.split("\n").find(line => line.startsWith("desktop_package_failure_causes="));
  assert.ok(diagnostic, result.stderr);
  const causes = JSON.parse(diagnostic.slice("desktop_package_failure_causes=".length));
  assert.equal(causes.length, 4);
  for (const message of ["synthetic_aggregate", "synthetic_attach", "synthetic_cleanup", "synthetic_command"]) {
    assert.ok(causes.some(stack => stack.includes(message)), message);
  }
});

for (const timedOut of [true, false]) {
  test(`package diagnostics distinguish ${timedOut ? "a killed command" : "a command rejection"}`, () => {
    const source = `import { promisify } from "node:util"; import { execFile } from "node:child_process";
      await promisify(execFile)(process.execPath, ["--eval", ${JSON.stringify(timedOut
        ? "setInterval(() => {}, 1000)" : 'process.stderr.write("synthetic_signature_rejected"); process.exit(3)')}],
      { timeout: ${timedOut ? 100 : 10000} });`;
    const result = spawnSync(process.execPath, ["--import", new URL("../release/desktop-package-diagnostics.mjs", import.meta.url).href,
      "--input-type=module", "--eval", source], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const diagnostic = result.stderr.split("\n").find(line => line.startsWith("desktop_package_command_failures="));
    assert.ok(diagnostic, result.stderr);
    const [command] = JSON.parse(diagnostic.slice("desktop_package_command_failures=".length));
    assert.equal(command.killed, timedOut);
    if (timedOut) assert.equal(command.signal, "SIGTERM");
    else {
      assert.equal(command.code, 3);
      assert.equal(command.stderr, "synthetic_signature_rejected");
    }
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-desktop-payload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, "app");
  await mkdir(join(app, "resources/web/assets"), { recursive: true });
  await mkdir(join(app, "resources/app.asar.unpacked"));
  for (const [path, bytes] of [["Ling Stack.exe", "PE fixture"], ["resources/app.asar", "asar fixture"],
    ["resources/web/index.html", "html"], ["resources/web/assets/main.js", "javascript"],
    ["resources/app.asar.unpacked/keyring.node", "keyring"], ["libEGL.dll", "runtime"], ["empty", ""]]) {
    await writeFile(join(app, path), bytes);
  }
  return { root, app };
}

test("actual macOS ZIP extraction removes only the OS temporary-root alias", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t), app = join(f.root, "Ling Stack.app"), archive = join(f.root, "fixture.zip");
  await mkdir(join(app, "Contents/Resources/gstack"), { recursive: true });
  await writeFile(join(app, "Contents/Resources/gstack/manifest.json"), "{}");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, archive]);
  const extracted = await extractCuaDriverFinalArtifact(archive, { platform: "darwin", artifactRole: "outer-zip" }, {
    mkdtemp: () => mkdtemp("/tmp/ling-cua-final-zip-"),
  });
  try {
    assert.notEqual(extracted.artifactRoot, await realpath(extracted.artifactRoot));
    const actual = await extractedApplicationPath(extracted.artifactRoot, "macos-arm64");
    assert.equal(actual, await realpath(actual));
    assert.equal((await inventoryApplicationTree(actual)).length, 1);
  } finally { await extracted.cleanup(); }
});

test("extracted Windows payload resolves to its physical plain directory", async t => {
  const f = await fixture(t);
  assert.equal(await extractedApplicationPath(f.app, "windows-x64"), await realpath(f.app));
});

test("extracted application selection rejects linked roots and linked product Apps", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), linkedRoot = join(f.root, "linked-root"), extraction = join(f.root, "extracted");
  await symlink(f.app, linkedRoot);
  await assert.rejects(extractedApplicationPath(linkedRoot, "windows-x64"), /plain directory/);
  await mkdir(extraction);
  await symlink(f.app, join(extraction, "Ling Stack.app"));
  await assert.rejects(extractedApplicationPath(extraction, "macos-arm64"), /plain directory/);
});

test("installer smoke refuses a local machine before creating or installing files", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(smokeWindowsInstaller({}), /fresh GitHub-hosted Windows/u);
});

for (const path of ["resources/web/assets/main.js", "resources/app.asar.unpacked/keyring.node", "libEGL.dll"]) {
  test(`complete payload comparison detects missing or changed ${path}`, async t => {
    const f = await fixture(t), copy = join(f.root, "copy");
    await cp(f.app, copy, { recursive: true });
    const original = await inventoryApplicationTree(f.app);
    assert.deepEqual(await inventoryApplicationTree(copy), original);
    await writeFile(join(copy, path), "different bytes");
    assert.notDeepEqual(await inventoryApplicationTree(copy), original);
    await rm(join(copy, path));
    assert.notDeepEqual(await inventoryApplicationTree(copy), original);
  });
}

test("payload inventory accepts empty files and rejects extra files", async t => {
  const f = await fixture(t), before = await inventoryApplicationTree(f.app);
  assert.ok(before.some(file => file.name === "empty" && file.sizeBytes === 0));
  await writeFile(join(f.app, "unexpected.dll"), "extra runtime");
  assert.notDeepEqual(await inventoryApplicationTree(f.app), before);
});

test("payload inventory only allows contained relative macOS links", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await symlink("web", join(f.app, "resources/Current"));
  await assert.rejects(inventoryApplicationTree(f.app), /payload link/u);
  assert.ok((await inventoryApplicationTree(f.app, { allowLinks: true })).some(file => file.type === "link"));
  await symlink("../../outside", join(f.app, "resources/escape"));
  await assert.rejects(inventoryApplicationTree(f.app, { allowLinks: true }), /payload link/u);
});

test("gstack diagnostic collection keeps stage receipts without copying executable payloads", async t => {
  const f = await fixture(t), output = join(f.root, "evidence");
  const stage = join(f.root, "artifacts/resource/desktop-resources");
  await mkdir(join(stage, "runtime"), { recursive: true });
  await writeFile(join(stage, "resource-stage.json"), '{"scope":"fixture"}\n');
  await writeFile(join(stage, "runtime/private.json"), '{"not":"diagnostic"}\n');
  await writeFile(join(stage, "server.exe"), "executable payload");
  const report = await collectGstackEvidence(f.root, output);
  assert.deepEqual(report.files.map(file => file.name), ["artifacts/resource/desktop-resources/resource-stage.json"]);
  assert.equal(report.acceptance, "not_granted");
  assert.equal(report.omitted.length, 0);
  await assert.rejects(collectGstackEvidence(f.root, output), /EEXIST/u);
});
