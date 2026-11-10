import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureSnapshot } from "./snapshot.mjs";

const cli = fileURLToPath(new URL("./verify-codex.mjs", import.meta.url));
const keyName = "LING_NATIVE_CANDIDATE_API_KEY";
const fixtureSecret = "candidate-test-secret-never-report";
const config = {
  executablePath: process.execPath, model: "candidate-model", provider: "candidate",
  providerConfiguration: { name: "Candidate test", base_url: "http://127.0.0.1:1/v1", wire_api: "responses" },
  credentialEnvironment: keyName,
};

test("candidate CLI rejects supplied check results before creating output or launching an engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-candidate-input-test-"));
  try {
    const input = join(root, "input.json"), output = join(root, "report");
    await writeFile(input, JSON.stringify({ ...config, checks: { packaged: "passed" }, secret: fixtureSecret }));
    const run = spawnSync(process.execPath, [cli, "--config", input, "--output", output], {
      env: { ...process.env, [keyName]: fixtureSecret }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout), { status: "failed", code: "candidate_config_invalid" });
    assert.equal(existsSync(output), false);
    assert.equal((run.stdout + run.stderr).includes(fixtureSecret), false);
    assert.equal(await readFile(input, "utf8"), JSON.stringify({ ...config, checks: { packaged: "passed" }, secret: fixtureSecret }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate snapshots reject linked runtime dist instead of claiming unchanged executed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-candidate-snapshot-test-"));
  try {
    assert.equal(spawnSync("git", ["init", root], { encoding: "utf8" }).status, 0);
    await mkdir(join(root, "packages", "demo"), { recursive: true });
    const target = join(root, "external-dist");
    await mkdir(target);
    await writeFile(join(target, "index.js"), "export const value = 1;\n");
    await symlink(target, join(root, "packages", "demo", "dist"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(captureSnapshot(root), /candidate_snapshot_runtime_symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejecting a launcher produces a failed private report, cleans only its temporary root and never runs the launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-candidate-launcher-test-"));
  try {
    const input = join(root, "input.json"), output = join(root, "report"), launcher = join(root, "fake-engine.sh");
    const marker = join(root, "must-not-run.txt");
    await writeFile(launcher, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    await writeFile(input, JSON.stringify({ ...config, executablePath: launcher }));
    const run = spawnSync(process.execPath, [cli, "--config", input, "--output", output], {
      env: { ...process.env, [keyName]: fixtureSecret }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout), report = JSON.parse(await readFile(result.report, "utf8"));
    assert.equal(report.failure, "candidate_native_binary_required");
    assert.equal(report.productionCertification, false);
    assert.equal(report.published, false);
    assert.equal(report.release.packaged.status, "not_run");
    assert.equal(report.cleanup.temporaryRootRemoved, true);
    assert.equal(existsSync(report.temporaryRoot), false);
    assert.equal(existsSync(marker), false);
    assert.deepEqual((await readdir(root)).sort(), ["fake-engine.sh", "input.json", "report"]);
    assert.equal((run.stdout + run.stderr + JSON.stringify(report)).includes(fixtureSecret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate CLI requires a dedicated credential variable and never includes its value in errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-candidate-secret-test-"));
  try {
    const input = join(root, "input.json"), output = join(root, "report");
    const env = { ...process.env }; delete env[keyName];
    await writeFile(input, JSON.stringify(config));
    const missing = spawnSync(process.execPath, [cli, "--config", input, "--output", output], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(missing.status, 1);
    assert.deepEqual(JSON.parse(missing.stdout), { status: "failed", code: "candidate_credential_missing" });
    await writeFile(input, JSON.stringify({ ...config, credentialEnvironment: "HOME" }));
    const unsafe = spawnSync(process.execPath, [cli, "--config", input, "--output", output], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(unsafe.status, 1);
    assert.deepEqual(JSON.parse(unsafe.stdout), { status: "failed", code: "candidate_config_invalid" });
    assert.equal(existsSync(output), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate CLI preserves an existing output directory and refuses to run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-candidate-output-test-"));
  try {
    const input = join(root, "input.json"), output = join(root, "report"), sentinel = join(output, "existing.txt");
    await mkdir(output);
    await writeFile(sentinel, "user-owned");
    await writeFile(input, JSON.stringify(config));
    const run = spawnSync(process.execPath, [cli, "--config", input, "--output", output], {
      env: { ...process.env, [keyName]: fixtureSecret }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout), { status: "failed", code: "candidate_output_exists" });
    assert.equal(await readFile(sentinel, "utf8"), "user-owned");
    assert.equal(existsSync(join(output, "report.json")), false);
    assert.equal((run.stdout + run.stderr).includes(fixtureSecret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
