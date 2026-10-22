import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { buildSupervisorRequest, readSupervisorArtifact, createSupervisorSpawn } from "../dist/features/execution-engines/windows-supervisor.js";

const executable = "C:\\Program Files\\Native Agent\\agent.exe";
const digest = "a".repeat(64);
const options = { cwd: "C:\\Users\\fixture\\private", env: { HOME: "isolated", TOKEN: "private-fixture" },
  shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true };

test("supervisor startup is bounded structured data, not argv or native stdin", () => {
  const frame = buildSupervisorRequest(executable, digest, ["a b", '"quoted"', "&not-a-shell"], options);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  const request = JSON.parse(frame.subarray(4));
  assert.deepEqual(request, { protocol: "ling.engine-supervisor.v1", executable, digest,
    args: ["a b", '"quoted"', "&not-a-shell"], cwd: options.cwd });
  assert.equal(frame.includes("private-fixture"), false);
});

for (const [name, file, hash, args, settings] of [
  ["relative executable", "agent.exe", digest, [], options],
  ["drive-relative executable", "C:agent.exe", digest, [], options],
  ["root-relative executable", "\\agent.exe", digest, [], options],
  ["UNC executable", "\\\\server\\share\\agent.exe", digest, [], options],
  ["cmd shim", "C:\\agent.cmd", digest, [], options],
  ["bad digest", executable, "anything", [], options],
  ["relative cwd", executable, digest, [], { ...options, cwd: "relative" }],
  ["shell", executable, digest, [], { ...options, shell: true }],
  ["inherited environment", executable, digest, [], { ...options, env: undefined }],
  ["argument NUL", executable, digest, ["a\0b"], options],
  ["oversize", executable, digest, ["x".repeat(65536)], options],
]) test(`supervisor rejects ${name} before spawning`, () => {
  assert.throws(() => buildSupervisorRequest(file, hash, args, settings), /engine_supervisor_spawn_invalid/);
});

test("packaged helper identity rejects changed bytes and stale metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-supervisor-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "ling-engine-supervisor.exe");
  const bytes = Buffer.alloc(256);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.write("PE\0\0", 128);
  await writeFile(path, bytes);
  const metadata = { schema: "ling.engine-supervisor.build.v1", version: "0.1.0", protocol: "ling.engine-supervisor.v1",
    platform: "win32-x64", executable: "ling-engine-supervisor.exe", sha256: createHash("sha256").update(bytes).digest("hex") };
  const manifest = join(root, "build-metadata.json");
  await writeFile(manifest, JSON.stringify(metadata));
  assert.equal((await readSupervisorArtifact(path)).path, await realpath(path));
  await writeFile(manifest, JSON.stringify({ ...metadata, version: "9.0.0" }));
  await assert.rejects(readSupervisorArtifact(path), /engine_supervisor_unavailable/);
  await writeFile(manifest, JSON.stringify(metadata));
  await writeFile(path, Buffer.concat([bytes, Buffer.from("changed")]));
  await assert.rejects(readSupervisorArtifact(path), /engine_supervisor_unavailable/);
});

function fixture() {
  const writes = [];
  const control = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done(); } });
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    stdio: [null, null, null, control], killed: false, exitCode: null, signalCode: null,
    kill() { this.killed = true; return true; } });
  const errors = [];
  child.on("error", error => errors.push(error.message));
  return { child, control, writes, errors };
}

test("owned spawn preserves native pipes and clears detached mode; owner pipe stays open", async () => {
  const f = fixture();
  const launch = createSupervisorSpawn({ path: "C:\\Ling\\ling-engine-supervisor.exe" }, executable, digest, (file, args, settings) => {
    assert.equal(file, "C:\\Ling\\ling-engine-supervisor.exe");
    assert.deepEqual(args, ["--owner-fd=3"]);
    assert.deepEqual(settings.stdio, ["pipe", "pipe", "pipe", "pipe"]);
    assert.equal(settings.detached, false);
    assert.equal(settings.env.TOKEN, "private-fixture");
    return f.child;
  });
  const child = launch(executable, ["--version"], options);
  assert.equal(child, f.child);
  assert.equal(f.writes.length, 1);
  assert.equal(f.control.writableEnded, false);
  assert.equal(child.stdin.read(), null);
  f.control.push('{"protocol":"ling.engine-supervisor.v1","version":"0.1.0","started":true}\n');
  await new Promise(resolve => setImmediate(resolve));
  child.emit("close", 0, null);
  assert.deepEqual(f.errors, []);
  assert.equal(f.control.destroyed, true);
});

for (const response of ["bad\n", "x".repeat(513), '{"started":true}\n',
  '{"protocol":"ling.engine-supervisor.v1","version":"0.1.0","started":true}\nextra']) {
  test("invalid helper acknowledgment kills owned helper without leaking payload", async () => {
    const f = fixture();
    createSupervisorSpawn({ path: "C:\\Ling\\ling-engine-supervisor.exe" }, executable, digest, () => f.child)(executable, [], options);
    f.control.push(response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.child.killed, true);
    assert.deepEqual(f.errors, ["engine_supervisor_protocol_error"]);
    f.child.emit("close", 1, null);
  });
}

test("helper exit without acknowledgment cannot masquerade as successful native exit", () => {
  const f = fixture();
  createSupervisorSpawn({ path: "C:\\Ling\\ling-engine-supervisor.exe" }, executable, digest, () => f.child)(executable, [], options);
  f.child.emit("close", 0, null);
  assert.deepEqual(f.errors, ["engine_supervisor_protocol_error"]);
});

test("cleanup kill is not a substitute for the supervisor startup acknowledgment", () => {
  const f = fixture();
  createSupervisorSpawn({ path: "C:\\Ling\\ling-engine-supervisor.exe" }, executable, digest, () => f.child)(executable, [], options);
  f.child.kill("SIGKILL");
  f.child.emit("close", null, "SIGKILL");
  assert.deepEqual(f.errors, ["engine_supervisor_protocol_error"]);
});
