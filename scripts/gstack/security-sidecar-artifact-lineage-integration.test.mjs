import "./managed-integration-guard.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEnvironment } from "./build-native-runtime.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { resourceCheckpoint, resourceTreeBytes } from "./resource-workspace.mjs";

const input = process.env.LING_GSTACK_RESOURCE_STAGE && resolve(process.env.LING_GSTACK_RESOURCE_STAGE);
const skip = !input && "Set the retained resource stage and use managed supervision";
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const protectedFiles = [
  ["source-manifest.json", "sha256:2921f0cfd111004b078f33b50b91efb053e5d81a661f9fc9473c9ff0e2dcbf8d"],
  ["native-build.json", "sha256:65eb00f9b33dffaa561804ae47e0207f9005b9b1e9c9c0ccf04078c3b5c61964"],
  ["resource-stage.json", "sha256:ab63d645623de138a7bec3b0cf4a58271fadf6f25b907b1c313ae314e38d818b"],
  ["runtime/tools/bun", "sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5"],
];

async function signalExit({ node, args, env, cwd }, signal) {
  const child = spawn(node, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let out = "", err = "", sent = false;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const terminal = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stderr.on("data", bytes => { err += bytes; });
    child.stdout.on("data", bytes => {
      out += bytes;
      if (!sent && out.includes("\n")) { sent = true; child.kill(signal); }
    });
    child.stdin.on("error", () => {});
    child.stdin.write('{"id":"signal-ready","op":"ping"}\n');
    const result = await terminal;
    assert.equal(sent, true);
    assert.deepEqual(result, { code: 0, signal: null }, `${signal}: ${err}`);
    assert.equal(err, "");
    assert.equal(JSON.parse(out).id, "signal-ready");
    return { requestedSignal: signal, ...result, response: JSON.parse(out) };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

test("frozen security classifier builds an actual Node sidecar and passes no-model NDJSON and lifecycle probes", { skip }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), "ling real security sidecar ")));
  t.after(() => rm(work, { recursive: true, force: true }));
  const output = join(work, "output");
  await mkdir(output);
  const runtime = join(input, "runtime"), bun = join(runtime, "tools/bun"), node = join(runtime, "tools/node");
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  for (const path of ["browse/dist/security-sidecar.js", "browse/dist/security-sidecar-build-provenance.json"]) {
    await assert.rejects(lstat(join(runtime, path)), { code: "ENOENT" });
  }
  const env = buildEnvironment({ bunPath: bun, nodePath: node, home: work, temporary: tmpdir() });
  for (const key of ["LING_GSTACK_RESOURCE_ROOT", "LING_GSTACK_RESOURCE_TOKEN"]) env[key] = process.env[key];
  const result = spawnSync(bun, ["--no-env-file", "--no-install", fileURLToPath(new URL("./build-portable-resources.ts", import.meta.url)),
    "security-sidecar", runtime, output], { cwd: runtime, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 ** 2 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(output, "browse/dist/security-sidecar-build-provenance.json")));
  assert.equal(report.sourceManifestChecksum, protectedFiles[0][1]);
  assert.equal(report.compiler.checksum, protectedFiles[3][1]);
  assert.equal(report.releaseEligible, false);
  assert.equal(report.artifacts.length, 1);
  assert.ok(report.inputs.some(file => file.path === "browse/src/security-classifier.ts"));
  assert.ok(report.inputs.some(file => file.path === "lib/state-root.ts"));
  assert.equal(report.runtimeResourceSelection, "pending");
  const artifact = join(output, report.artifacts[0].path);
  assert.equal((await readGstackClosureFileRecord(artifact)).checksum, report.artifacts[0].checksum);
  for (const record of [...report.inputs, ...report.externalInputs]) {
    const actual = await readGstackClosureFileRecord(join(runtime, record.path));
    assert.equal(actual.checksum, record.checksum, record.path);
    assert.equal(actual.sizeBytes, record.sizeBytes, record.path);
  }
  await writeFile(join(output, "package.json"), '{"type":"module"}\n');
  const guard = join(work, "no-network.cjs");
  await writeFile(guard, `const deny=()=>{process.stderr.write("unexpected-network-attempt\\n");throw new Error("network forbidden in protocol probe");};
    globalThis.fetch=deny;globalThis.WebSocket=deny;
    for(const [module,methods] of [["http",["request","get"]],["https",["request","get"]],["net",["connect","createConnection"]],["tls",["connect"]]]){
      const target=require("node:"+module);for(const method of methods)target[method]=deny;}
    require("node:module").syncBuiltinESMExports();`);
  const args = ["--no-warnings", "--permission", `--allow-fs-read=${work}`, "--require", guard, artifact];
  const syntax = spawnSync(node, ["--check", artifact], { cwd: work, env, encoding: "utf8", timeout: 15_000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const requests = [
    { id: "ping", op: "ping" }, { id: "status", op: "status" }, { id: "unknown", op: "not-a-real-operation" },
    { id: "missing-text", op: "scan-page-content" }, { op: "ping" },
  ];
  const response = spawnSync(node, args, { cwd: work, env, input: requests.map(request => JSON.stringify(request)).join("\n") + "\n{not-json}\n\n",
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 ** 2 });
  assert.equal(response.status, 0, response.stderr);
  assert.equal(response.stderr, "");
  const messages = response.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(messages, [
    { id: "ping", ok: true, verdict: { layer: "ping", verdict: "alive", score: 0 } },
    { id: "status", ok: true, status: { testsavant: "off" } },
    { id: "unknown", ok: false, error: "unknown-op:not-a-real-operation" },
    { id: "missing-text", ok: false, error: "missing-text" },
    { id: "<malformed>", ok: false, error: "malformed-json" },
  ]);
  const eof = spawnSync(node, args, { cwd: work, env, input: "", encoding: "utf8", timeout: 10_000 });
  assert.equal(eof.status, 0, eof.stderr);
  assert.equal(eof.stdout, "");
  assert.equal(eof.stderr, "");
  const signals = [];
  for (const signal of ["SIGTERM", "SIGINT"]) signals.push(await signalExit({ node, args, env, cwd: work }, signal));
  await assert.rejects(lstat(join(work, ".gstack/models")), { code: "ENOENT" });
  for (const [path, expected] of protectedFiles) assert.equal((await readGstackClosureFileRecord(join(input, path))).checksum, expected);
  const peakScratchBytes = await resourceTreeBytes(work);
  assert.ok(peakScratchBytes < 32 * 1024 ** 2);
  await resourceCheckpoint(process.env.LING_GSTACK_RESOURCE_ROOT);
  const testInputs = [];
  for (const path of ["security-sidecar-artifact-lineage-integration.test.mjs", "security-sidecar-artifact-lineage.test.mjs", "build-native-runtime.mjs", "native-runtime-integration.test.mjs"]) {
    testInputs.push({ path: `scripts/gstack/${path}`, ...await readGstackClosureFileRecord(fileURLToPath(new URL(path, import.meta.url))) });
  }
  const proof = { schemaVersion: 1, deliveryStage: "compiled-resource-prerequisites", releaseEligible: false,
    verificationScope: "actual-frozen-security-sidecar-compilation-and-no-model-node-protocol-only", report, testInputs,
    retainedResourceChecksum: protectedFiles[2][1], node: await readGstackClosureFileRecord(node),
    protocol: { messages, eofExit: eof.status, signals, classifier: "off", networkGuard: "javascript-deny-hooks-not-os-network-quota",
      fileWritesNativeAddonsAndChildProcesses: "denied-by-node-permission-model", modelDownloaded: false, realInference: "pending" },
    peakScratchBytes, completeNativeBuild: "pending", completeResourcePreparation: "pending", cleanup: "pending" };
  await rm(work, { recursive: true, force: true });
  await assert.rejects(lstat(work), { code: "ENOENT" });
  proof.cleanup = "complete";
  if (process.env.LING_GSTACK_SECURITY_SIDECAR_PROOF_OUTPUT) {
    const path = resolve(process.env.LING_GSTACK_SECURITY_SIDECAR_PROOF_OUTPUT);
    assert.equal(path, join(process.env.LING_GSTACK_RESOURCE_ROOT, "artifacts/report/security-sidecar-artifact-lineage-proof.json"));
    const bytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
    await writeFile(path, bytes, { flag: "wx" });
    t.diagnostic(JSON.stringify({ proofPath: path, sizeBytes: bytes.length, checksum: hash(bytes), peakScratchBytes,
      inputCount: report.inputs.length, artifact: report.artifacts[0], cleanup: proof.cleanup }));
  }
});
