import assert from "node:assert/strict";
import { once } from "node:events";
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { preparePlatformNativeProcessLaunch } from "../dist/runtime/sandbox/native-process-launch.js";
import { withOwnedNativeProcess } from "../dist/features/execution-engines/owned-native-process.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-native-boundary-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace"), operationRoot = join(root, "operation"), nativeHome = join(root, "native");
  for (const path of [workspaceRoot, operationRoot, nativeHome]) await mkdir(path, { mode: 0o700 });
  return { root, workspaceRoot, operationRoot, nativeHome };
}
async function run(t, launch, f, args) {
  const child = launch("/bin/sh", args, { cwd: f.operationRoot, env: { HOME: f.operationRoot, PATH: "/usr/bin:/bin" },
    shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"], timeout: 3000, killSignal: "SIGKILL" });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  child.stdin.end();
  const [code, signal] = await once(child, "close");
  return { code, signal, stdout, stderr };
}

test("native macOS launch permits a real workspace read and an explicitly allowed write", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  const input = join(f.workspaceRoot, "input.txt"), output = join(f.workspaceRoot, "result.txt");
  await writeFile(input, "Workspace sentinel");
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [f.workspaceRoot] });
  const result = await run(t, launch, f, ["-c", '/bin/cat "$1"; printf Done > "$2"', "probe", input, output]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stdout, "Workspace sentinel");
  assert.equal(await readFile(output, "utf8"), "Done");
});

test("native read-only ignores writable workspace grants but retains private session output", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  const output = join(f.workspaceRoot, "result.txt"), session = join(f.nativeHome, "sessions");
  await mkdir(session);
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "read_only",
    allowedWritePaths: [f.workspaceRoot] });
  const rejected = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", output]);
  assert.notEqual(rejected.code, 0, JSON.stringify(rejected));
  await assert.rejects(access(output), { code: "ENOENT" });
  const result = await run(t, launch, f, ["-c", 'printf Session > "$1"; printf Operation > "$2"', "probe",
    join(session, "turn.txt"), join(f.operationRoot, "output.txt")]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(await readFile(join(session, "turn.txt"), "utf8"), "Session");
  assert.equal(await readFile(join(f.operationRoot, "output.txt"), "utf8"), "Operation");
});

test("native write grant permits only its subtree and explicit external output, with literal quoted paths", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  const allowed = join(f.workspaceRoot, 'quoted " output (deny default)'), external = join(f.root, "external");
  await mkdir(allowed); await mkdir(external);
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [allowed, join(external, "new.txt")] });
  const result = await run(t, launch, f, ["-c", 'printf Scoped > "$1"; printf External > "$2"', "probe",
    join(allowed, "new.txt"), join(external, "new.txt")]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(await readFile(join(allowed, "new.txt"), "utf8"), "Scoped");
  assert.equal(await readFile(join(external, "new.txt"), "utf8"), "External");
  for (const denied of [join(f.workspaceRoot, "sibling.txt"), join(external, "sibling.txt")]) {
    const rejected = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", denied]);
    assert.notEqual(rejected.code, 0, JSON.stringify(rejected));
    await assert.rejects(access(denied), { code: "ENOENT" });
  }
});

test("native child cannot read or modify internal Ling state or outside paths including symlink aliases", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  const internal = join(f.workspaceRoot, ".ling-stack"), outside = join(f.root, "outside");
  await mkdir(internal); await mkdir(outside);
  for (const directory of [internal, outside]) await writeFile(join(directory, "sentinel.txt"), "Private sentinel");
  await symlink(outside, join(f.workspaceRoot, "outside-link"));
  await symlink(internal, join(f.workspaceRoot, "internal-link"));
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [f.workspaceRoot] });
  for (const directory of [internal, outside, join(f.workspaceRoot, "outside-link"), join(f.workspaceRoot, "internal-link")]) {
    const path = join(directory, "sentinel.txt");
    const read = await run(t, launch, f, ["-c", '/bin/cat "$1"', "probe", path]);
    assert.notEqual(read.code, 0, JSON.stringify(read));
    assert.equal(read.stdout, "");
    const write = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", path]);
    assert.notEqual(write.code, 0, JSON.stringify(write));
    assert.equal(await readFile(path, "utf8"), "Private sentinel");
  }
});

test("native runtime cannot overwrite its config or credential files even with a conflicting grant", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.nativeHome, "credentials"));
  const paths = [join(f.nativeHome, "config.toml"), join(f.nativeHome, "credentials", "synthetic.json")];
  for (const path of paths) await writeFile(path, "Synthetic protected value");
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [f.workspaceRoot, f.nativeHome] });
  for (const path of paths) {
    const rejected = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", path]);
    assert.notEqual(rejected.code, 0, JSON.stringify(rejected));
    assert.equal(await readFile(path, "utf8"), "Synthetic protected value");
  }
});

for (const policyProfileId of ["read_only", "workspace_write"]) test(`native Kimi ${policyProfileId} can atomically rebuild its workspace index while other home writes remain denied`,
  { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const base = await fixture(t), nativeHome = join(base.root, 'native.[+]^$(){}|?\\"');
  await rename(base.nativeHome, nativeHome);
  const f = { ...base, nativeHome }, persistentKimiHome = join(f.root, "persistent-kimi");
  await mkdir(persistentKimiHome);
  for (const name of ["sessions", "store", "cache", "logs", "blobs"]) {
    await mkdir(join(persistentKimiHome, name));
    await symlink(join(persistentKimiHome, name), join(f.nativeHome, name));
  }
  const protectedPaths = [join(f.nativeHome, "config.toml"), join(persistentKimiHome, "config.toml"),
    join(persistentKimiHome, "session_index.jsonl")];
  for (const home of [f.nativeHome, persistentKimiHome]) {
    await mkdir(join(home, "credentials"));
    protectedPaths.push(join(home, "credentials", "synthetic.json"));
  }
  for (const path of protectedPaths) await writeFile(path, "Synthetic protected value");
  await mkdir(join(f.nativeHome, "nested"));
  const launch = await preparePlatformNativeProcessLaunch({ ...f, persistentKimiHome, executable: "/bin/sh",
    policyProfileId, allowedWritePaths: [f.workspaceRoot, f.nativeHome, persistentKimiHome] });
  const index = join(f.nativeHome, "workspaces.json"), temporary = `${index}.tmp.123.0123abcd`;
  const sessionIndex = join(f.nativeHome, "session_index.jsonl");
  const result = await run(t, launch, f, ["-c", 'printf \'{"version":1,"workspaces":{}}\' > "$1" && /bin/mv "$1" "$2"', "probe", temporary, index]);
  assert.equal(result.code, 0, "Kimi must be able to atomically publish its rebuildable workspace catalog");
  assert.equal(await readFile(index, "utf8"), '{"version":1,"workspaces":{}}');
  const appended = await run(t, launch, f, ["-c", 'printf \'First record\\n\' >> "$1" && printf \'Second record\\n\' >> "$1"', "probe", sessionIndex]);
  assert.equal(appended.code, 0, "Kimi must be able to append and close its disposable legacy index");
  assert.equal(await readFile(sessionIndex, "utf8"), "First record\nSecond record\n");
  const workspaceOutput = join(f.workspaceRoot, "output.txt");
  const workspaceWrite = await run(t, launch, f, ["-c", 'printf Workspace > "$1"', "probe", workspaceOutput]);
  if (policyProfileId === "read_only") {
    assert.notEqual(workspaceWrite.code, 0, "Internal Kimi metadata must not enable workspace writes in read-only mode");
    await assert.rejects(access(workspaceOutput), { code: "ENOENT" });
  } else assert.equal(await readFile(workspaceOutput, "utf8"), "Workspace");
  for (const path of [...protectedPaths, join(f.nativeHome, "unlisted.json"), join(persistentKimiHome, "unlisted.json"),
    `${index}.tmp.0.0123abcd`, `${index}.tmp.123.0123abcg`, `${index}.tmp.123.0123abc`, `${index}.tmp.123.0123abcde`,
    `${index}.tmp.123.0123abcd.extra`, `${index}.backup`, join(f.nativeHome, "nested", "workspaces.json"),
    join(f.nativeHome, "nested", "workspaces.json.tmp.123.0123abcd"), `${sessionIndex}.tmp.123.0123abcd`,
    `${sessionIndex}.backup`, join(f.nativeHome, "nested", "session_index.jsonl")]) {
    const denied = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", path]);
    assert.notEqual(denied.code, 0, "Metadata access must not authorize other home writes, including conflicting grants");
    if (protectedPaths.includes(path)) assert.equal(await readFile(path, "utf8"), "Synthetic protected value");
    else await assert.rejects(access(path), { code: "ENOENT" });
  }
  const outside = join(f.root, "outside.txt"); await writeFile(outside, "Outside protected value");
  for (const path of [index, temporary, sessionIndex]) {
    await rm(path, { force: true }); await symlink(outside, path);
    const denied = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", path]);
    assert.notEqual(denied.code, 0, "An allowed metadata filename must not grant its symlink target");
    assert.equal(await readFile(outside, "utf8"), "Outside protected value");
  }
});

test("native system library access cannot expose the macOS Data volume alias", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t), outside = join(f.root, "outside.txt");
  await writeFile(outside, "Private Data-volume sentinel");
  const alias = join("/System/Volumes/Data", outside);
  assert.equal(await readFile(alias, "utf8"), "Private Data-volume sentinel");
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "read_only", allowedWritePaths: [] });
  const result = await run(t, launch, f, ["-c", '/bin/cat "$1"', "probe", alias]);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.stdout, "");
});

test("native internal-state denial includes nested workspaces", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t), internal = join(f.workspaceRoot, "nested", ".ling-stack");
  await mkdir(internal, { recursive: true });
  const path = join(internal, "sentinel.txt"); await writeFile(path, "Nested private state");
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [f.workspaceRoot] });
  const read = await run(t, launch, f, ["-c", '/bin/cat "$1"', "probe", path]);
  assert.notEqual(read.code, 0, JSON.stringify(read)); assert.equal(read.stdout, "");
  const write = await run(t, launch, f, ["-c", 'printf Blocked > "$1"', "probe", path]);
  assert.notEqual(write.code, 0, JSON.stringify(write));
  assert.equal(await readFile(path, "utf8"), "Nested private state");
});

test("native network denial prevents contact with a verified live loopback sentinel", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t);
  let accepted = 0;
  const server = createServer(socket => { accepted++; socket.end("Alive"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const control = connect(port, "127.0.0.1");
  const [bytes] = await once(control, "data");
  assert.equal(bytes.toString(), "Alive");
  control.destroy();
  assert.equal(accepted, 1);
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [f.workspaceRoot] });
  const result = await run(t, launch, f, ["-c", '/usr/bin/nc -w 1 127.0.0.1 "$1"', "probe", String(port)]);
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(accepted, 1, "The native child must not reach the listener");
});

for (const target of ["workspaceRoot", "operationRoot", "nativeHome"]) test(`native launch rejects ${target} replacement after preparation`,
  { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
    const f = await fixture(t);
    const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
      allowedWritePaths: [f.workspaceRoot] });
    await rename(f[target], `${f[target]}-old`); await mkdir(f[target]);
    await assert.rejects(run(t, launch, f, ["-c", "exit 0"]), /native_process_boundary_invalid/);
  });

test("native launch rejects a granted missing directory replaced by an outside symlink", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t), allowed = join(f.workspaceRoot, "future"), outside = join(f.root, "outside");
  await mkdir(outside);
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "workspace_write",
    allowedWritePaths: [allowed] });
  await symlink(outside, allowed);
  await assert.rejects(run(t, launch, f, ["-c", "exit 0"]), /native_process_boundary_invalid/);
});

test("native launch rejects changed executable identity, shell execution and invalid arguments", { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
  const f = await fixture(t), executable = join(f.operationRoot, "shell");
  await copyFile("/bin/sh", executable);
  const launch = await preparePlatformNativeProcessLaunch({ ...f, executable, policyProfileId: "workspace_write", allowedWritePaths: [] });
  const options = { cwd: f.operationRoot, shell: false, stdio: ["pipe", "pipe", "pipe"] };
  assert.throws(() => launch("/bin/sh", ["-c", "exit 0"], options), /native_process_boundary_invalid/);
  assert.throws(() => launch(executable, ["-c", "exit 0"], { ...options, shell: true }), /native_process_boundary_invalid/);
  assert.throws(() => launch(executable, ["bad\0arg"], options), /native_process_boundary_invalid/);
  await rename(executable, `${executable}-old`); await copyFile("/bin/sh", executable);
  assert.throws(() => launch(executable, ["-c", "exit 0"], options), /native_process_boundary_invalid/);
});

for (const cancelled of [false, true]) test(`native sandbox ${cancelled ? "cancellation" : "completion"} reaps a descendant in the owned process group`,
  { skip: process.platform !== "darwin", timeout: 8000 }, async t => {
    const f = await fixture(t), abort = new AbortController();
    const launch = await preparePlatformNativeProcessLaunch({ ...f, executable: "/bin/sh", policyProfileId: "read_only", allowedWritePaths: [] });
    let pid;
    t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const result = withOwnedNativeProcess({ executable: "/bin/sh", args: ["-c", '/bin/sleep 60 & printf "%s" "$!"; wait'],
      environment: {}, root: f.operationRoot, signal: abort.signal, launch }, async ({ output }) => {
      pid = Number((await once(output, "data"))[0].toString());
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      if (cancelled) { abort.abort(); await new Promise(() => {}); }
      return pid;
    });
    if (cancelled) await assert.rejects(result, { code: "cancelled" }); else assert.equal(await result, pid);
    const deadline = performance.now() + 2500;
    for (;;) {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(error.code, "ESRCH"); break; }
      assert.ok(performance.now() < deadline, "Sandbox descendant survived owned process cleanup");
      await delay(10);
    }
  });
