import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { startBoundedHostTerminal } from "../dist/runtime/acp/host-terminal-process.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-host-terminal-test-")));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const terminals = [];
  t.after(async () => {
    for (const terminal of terminals) await terminal.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, async start(options) {
    const terminal = await startBoundedHostTerminal({ workspaceRoot, cwd: workspaceRoot,
      executable: "/bin/sh", policyProfileId: "workspace_write", allowedWritePaths: [workspaceRoot],
      signal: new AbortController().signal, ...options });
    terminals.push(terminal);
    return terminal;
  } };
}
const native = { skip: process.platform !== "darwin", timeout: 8000 };

test("terminal revalidates its approved action immediately before spawn", native, async t => {
  const f = await fixture(t);
  let checks = 0;
  await assert.rejects(f.start({ args: ["-c", "printf forbidden > before-spawn.txt"],
    beforeSpawn: () => { checks++; throw new Error("approved action changed"); } }), /approved action changed/);
  assert.equal(checks, 1);
  await assert.rejects(access(join(f.workspaceRoot, "before-spawn.txt")), { code: "ENOENT" });
});

test("terminal rejects asynchronous spawn fences and cancellation inside its fence", native, async t => {
  const f = await fixture(t);
  await assert.rejects(f.start({ args: ["-c", "touch async-fence"], beforeSpawn: async () => {} }), { code: "terminal_invalid" });
  const abort = new AbortController();
  await assert.rejects(f.start({ signal: abort.signal, args: ["-c", "touch cancelled-fence"],
    beforeSpawn: () => abort.abort() }), { name: "AbortError" });
  for (const name of ["async-fence", "cancelled-fence"]) await assert.rejects(access(join(f.workspaceRoot, name)), { code: "ENOENT" });
});
async function eventually(check) {
  const until = Date.now() + 3000;
  while (!await check()) { assert.ok(Date.now() < until, "Expected terminal observation did not arrive"); await delay(10); }
}

test("contained terminal returns a live handle, runs in the approved cwd and records real exit", {
  skip: process.platform !== "darwin", timeout: 8000,
}, async t => {
  const f = await fixture(t);
  const cwd = join(f.workspaceRoot, "subdirectory");
  await mkdir(cwd);
  const terminal = await f.start({ cwd, args: ["-c", 'pwd; printf written > result.txt; /bin/sleep 0.2; exit 7'] });
  assert.ok(terminal.pid > 0);
  assert.equal(terminal.output().exitStatus, undefined, "Creation is not an exit");
  assert.deepEqual(await terminal.waitForExit(), { exitCode: 7 });
  assert.deepEqual(terminal.output(), { output: cwd + "\n", truncated: false, exitStatus: { exitCode: 7 } });
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "written");
  const home = terminal.operationRoot;
  await terminal.dispose();
  await assert.rejects(access(home), { code: "ENOENT" });
  await terminal.dispose();
  assert.throws(() => terminal.output(), { code: "terminal_disposed" });
});

test("terminal combines cumulative stdout/stderr and bounds complete split UTF-8 characters", native, async t => {
  const f = await fixture(t);
  const terminal = await f.start({ executable: process.execPath, outputByteLimit: 8, args: ["-e", `
    const bytes = Buffer.from("\\u4e2d\\u6587");
    process.stdout.write("123456789");
    process.stdout.write(bytes.subarray(0, 1));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(1));
      setTimeout(() => process.stderr.write("!"), 30);
    }, 30);
  `] });
  assert.deepEqual(await terminal.waitForExit(), { exitCode: 0 });
  assert.deepEqual(terminal.output(), { output: "9\u4e2d\u6587!", truncated: true, exitStatus: { exitCode: 0 } });
  assert.ok(Buffer.byteLength(terminal.output().output) <= 8);
  const zero = await f.start({ args: ["-c", "printf hidden"], outputByteLimit: 0 });
  await zero.waitForExit();
  assert.deepEqual(zero.output(), { output: "", truncated: true, exitStatus: { exitCode: 0 } });
});

test("terminal receives no inherited account variables and uses a private disposable home", native, async t => {
  const f = await fixture(t);
  const old = process.env.LING_TERMINAL_SYNTHETIC_SECRET;
  process.env.LING_TERMINAL_SYNTHETIC_SECRET = "synthetic-only-secret";
  t.after(() => { if (old === undefined) delete process.env.LING_TERMINAL_SYNTHETIC_SECRET; else process.env.LING_TERMINAL_SYNTHETIC_SECRET = old; });
  const terminal = await f.start({ executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"] });
  await terminal.waitForExit();
  const env = JSON.parse(terminal.output().output);
  assert.equal(env.LING_TERMINAL_SYNTHETIC_SECRET, undefined);
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NO_COLOR", "TERM", "GIT_TERMINAL_PROMPT", "SHELL"].sort());
  assert.equal(env.HOME, join(terminal.operationRoot, "home"));
  assert.equal(env.TMPDIR, join(terminal.operationRoot, "operation"));
  assert.equal(env.NO_COLOR, "1"); assert.equal(env.TERM, "dumb");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0"); assert.equal(env.SHELL, process.execPath);
  await terminal.dispose();
  await assert.rejects(access(env.HOME), { code: "ENOENT" });
});

test("terminal read-only policy blocks writes and workspace policy excludes private paths and aliases", native, async t => {
  const f = await fixture(t);
  const readonly = await f.start({ policyProfileId: "read_only", args: ["-c", "printf blocked > forbidden.txt"] });
  assert.notEqual((await readonly.waitForExit()).exitCode, 0);
  await assert.rejects(access(join(f.workspaceRoot, "forbidden.txt")), { code: "ENOENT" });
  const outside = join(f.root, "outside.txt"), internal = join(f.workspaceRoot, ".ling-stack");
  await mkdir(internal); await writeFile(outside, "private sentinel");
  await writeFile(join(internal, "secret.txt"), "private sentinel");
  await symlink(outside, join(f.workspaceRoot, "alias.txt"));
  for (const path of [outside, join(internal, "secret.txt"), join(f.workspaceRoot, "alias.txt")]) {
    const terminal = await f.start({ args: ["-c", '/bin/cat "$1"; printf overwritten > "$1"', "probe", path] });
    assert.notEqual((await terminal.waitForExit()).exitCode, 0);
    assert.equal(terminal.output().output.includes("private sentinel"), false);
    assert.equal(await readFile(path, "utf8"), "private sentinel");
  }
});

test("terminal cannot use an out-of-workspace or private-state cwd", native, async t => {
  const f = await fixture(t);
  await mkdir(join(f.workspaceRoot, ".ling-stack"));
  await symlink(f.root, join(f.workspaceRoot, "outside"));
  for (const cwd of [f.root, join(f.workspaceRoot, "outside"), join(f.workspaceRoot, ".ling-stack")]) {
    await assert.rejects(f.start({ cwd, args: ["-c", "printf forbidden > cwd-result"] }));
  }
  await assert.rejects(access(join(f.root, "cwd-result")), { code: "ENOENT" });
});

test("terminal networking remains denied by the actual OS boundary", native, async t => {
  const f = await fixture(t);
  let connected = false;
  const server = createServer(socket => { connected = true; socket.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const terminal = await f.start({ executable: process.execPath, args: ["-e", `
    const socket = require("node:net").connect(${server.address().port}, "127.0.0.1");
    socket.on("connect", () => { process.stdout.write("connected"); socket.end(); });
    socket.on("error", () => process.stdout.write("blocked"));
  `] });
  assert.deepEqual(await terminal.waitForExit(), { exitCode: 0 });
  assert.equal(terminal.output().output, "blocked");
  assert.equal(connected, false);
});

test("kill preserves actual final output and a cancelled exit waiter does not kill the command", native, async t => {
  const f = await fixture(t);
  const terminal = await f.start({ args: ["-c", "printf ready; exec /bin/sleep 30"] });
  await eventually(() => terminal.output().output === "ready");
  const abort = new AbortController();
  const waiting = terminal.waitForExit(abort.signal);
  abort.abort(new Error("cancel one waiter"));
  await assert.rejects(waiting, /cancel one waiter/);
  assert.equal(terminal.output().exitStatus, undefined);
  await terminal.kill();
  assert.deepEqual(await terminal.waitForExit(), { signal: "SIGKILL" });
  assert.deepEqual(terminal.output(), { output: "ready", truncated: false, exitStatus: { signal: "SIGKILL" } });
  await terminal.kill();
});

test("terminal lifetime cancellation and timeout both reap the real process", native, async t => {
  const f = await fixture(t);
  for (const mode of ["cancel", "timeout"]) {
    const abort = new AbortController();
    const terminal = await f.start({ signal: abort.signal, timeoutMs: mode === "timeout" ? 100 : 1000,
      args: ["-c", "printf ready; exec /bin/sleep 30"] });
    await eventually(() => terminal.output().output === "ready");
    if (mode === "cancel") abort.abort();
    assert.deepEqual(await terminal.waitForExit(), { signal: "SIGKILL" });
    assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" });
  }
});

test("normal parent exit reaps children holding output pipes without inventing parent failure", native, async t => {
  const f = await fixture(t);
  const terminal = await f.start({ args: ["-c", '/bin/sleep 30 & printf "%s" "$!"; exit 7'] });
  assert.deepEqual(await terminal.waitForExit(), { exitCode: 7 });
  const childPid = Number(terminal.output().output);
  assert.ok(childPid > 0);
  await eventually(() => { try { process.kill(childPid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
});

test("parent exit reaps a descendant missed by the first group signal", native, async t => {
  const f = await fixture(t);
  const module = new URL("../dist/runtime/acp/host-terminal-process.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {access,rm} from "node:fs/promises";
    import {setTimeout as delay} from "node:timers/promises";
    import {startBoundedHostTerminal} from ${JSON.stringify(module)};
    const cwd = ${JSON.stringify(f.workspaceRoot)};
    const originalKill = process.kill.bind(process);
    let terminal, groupSignals = 0;
    try {
      terminal = await startBoundedHostTerminal({ workspaceRoot:cwd,cwd,executable:"/bin/sh",
        args:["-c",'/bin/sleep 30 & printf "%s" "$!"; wait'], policyProfileId:"workspace_write",
        allowedWritePaths:[cwd],signal:new AbortController().signal });
      process.send({ownedGroup:terminal.pid,root:terminal.operationRoot});
      const deadline = Date.now() + 2000;
      while (!terminal.output().output) { assert.ok(Date.now() < deadline); await delay(5); }
      const descendant = Number(terminal.output().output);
      assert.ok(descendant > 0 && descendant !== terminal.pid);
      process.kill = (pid,signal) => {
        if (pid === -terminal.pid && signal === "SIGKILL" && ++groupSignals === 1) {
          // Reproduce a child missed by the first group signal during fork.
          return originalKill(terminal.pid, signal);
        }
        return originalKill(pid,signal);
      };
      await terminal.kill();
      assert.equal(groupSignals, 2);
      assert.deepEqual(await terminal.waitForExit(), {signal:"SIGKILL"});
      const until = Date.now() + 2000;
      for (;;) {
        try { originalKill(descendant,0); }
        catch (error) { assert.equal(error.code,"ESRCH"); break; }
        assert.ok(Date.now() < until, "Owned descendant is still alive"); await delay(5);
      }
      await terminal.dispose();
      await assert.rejects(access(terminal.operationRoot), {code:"ENOENT"});
    } finally {
      process.kill = originalKill;
      if (terminal) {
        try { originalKill(-terminal.pid,"SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await rm(terminal.operationRoot,{recursive:true,force:true});
      }
      if(process.connected)process.disconnect();
    }
  `], { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = once(child, "close");
  let owned, stderr = "";
  child.on("message", message => { owned = message; });
  child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  t.after(async () => {
    clearTimeout(deadline); child.kill("SIGKILL");
    if (owned) {
      try { process.kill(-owned.ownedGroup, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await rm(owned.root, { recursive: true, force: true });
    }
  });
  const [code, signal] = await closed;
  clearTimeout(deadline);
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});

for (const probe of ["gone", "disappearing", "live", "live-closed-pipes", "denied"]) test(`post-exit group EPERM requires absence proof: ${probe}`, native, async t => {
  const f = await fixture(t);
  const module = new URL("../dist/runtime/acp/host-terminal-process.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {access,rm} from "node:fs/promises";
    import {setTimeout as delay} from "node:timers/promises";
    import {startBoundedHostTerminal} from ${JSON.stringify(module)};
    const cwd = ${JSON.stringify(f.workspaceRoot)}, probe = ${JSON.stringify(probe)};
    const originalKill = process.kill.bind(process);
    let terminal, signals = 0, probes = 0, releaseProbe = false, reported = false, killSettled = false;
    const denied = () => { throw Object.assign(new Error("Fixture group signal denied"),{code:"EPERM"}); };
    process.on("message", async message => {
      if (!message.allowAbsent) return;
      assert.equal(killSettled,false,"Cleanup settled without absence proof");
      await access(terminal.operationRoot);
      releaseProbe = true;
    });
    try {
      terminal = await startBoundedHostTerminal({ workspaceRoot:cwd,cwd,executable:"/bin/sh",
        args:["-c",["gone","disappearing"].includes(probe) ? 'printf ready; exec /bin/sleep 30'
          : '/bin/sleep 30 ' + (probe === "live-closed-pipes" ? '>/dev/null 2>&1 ' : '') + '& printf ready; wait'],
        policyProfileId:"workspace_write",allowedWritePaths:[cwd],signal:new AbortController().signal });
      process.send({ownedGroup:terminal.pid,root:terminal.operationRoot});
      const deadline = Date.now() + 2000;
      while (!terminal.output().output) { assert.ok(Date.now() < deadline); await delay(5); }
      process.kill = (pid,signal) => {
        if (pid !== -terminal.pid) return originalKill(pid,signal);
        if (signal === 0) {
          probes++;
          if (probe === "disappearing" && !releaseProbe) {
            if (!reported) { reported = true; process.send({probePending:true}); }
            denied();
          }
          if (probe === "denied") denied();
          return originalKill(pid,signal);
        }
        if (signal === "SIGKILL" && ++signals > 1) denied();
        return originalKill(terminal.pid,signal);
      };
      const killing = terminal.kill();
      void killing.then(() => {killSettled=true;},() => {killSettled=true;});
      if (["gone","disappearing"].includes(probe)) {
        await killing;
        assert.deepEqual(await terminal.waitForExit(),{signal:"SIGKILL"});
        await terminal.dispose();
        await assert.rejects(access(terminal.operationRoot),{code:"ENOENT"});
      } else {
        await assert.rejects(killing,{code:"terminal_cleanup_failed"});
        await assert.rejects(terminal.dispose(),{code:"terminal_cleanup_failed"});
        await access(terminal.operationRoot);
      }
      assert.equal(signals,2); assert.ok(probes >= 1);
      if(probe === "gone")assert.equal(probes,1);
      if(probe === "disappearing")assert.ok(releaseProbe && probes >= 2);
    } finally {
      process.kill=originalKill;
      if(terminal) {
        try{originalKill(-terminal.pid,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}
        await rm(terminal.operationRoot,{recursive:true,force:true});
      }
      if(process.connected)process.disconnect();
    }
  `], { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = once(child, "close");
  let owned, stderr = "";
  child.on("message", message => {
    if (message.probePending) child.send({ allowAbsent: true });
    else owned = message;
  });
  child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  t.after(async () => {
    clearTimeout(deadline); child.kill("SIGKILL");
    if (owned) {
      try { process.kill(-owned.ownedGroup, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await rm(owned.root, { recursive: true, force: true });
    }
  });
  const [code, signal] = await closed;
  clearTimeout(deadline);
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});

test("terminal launch snapshots caller arguments and rejects an already cancelled start", native, async t => {
  const f = await fixture(t);
  const args = ["-c", "printf original"];
  const starting = f.start({ args });
  args[1] = "printf substituted";
  const terminal = await starting;
  await terminal.waitForExit();
  assert.equal(terminal.output().output, "original");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.start({ signal: abort.signal, args: ["-c", "touch cancelled-start"] }), { name: "AbortError" });
  await assert.rejects(access(join(f.workspaceRoot, "cancelled-start")), { code: "ENOENT" });
});

for (const mode of ["late-close", "signal-error", "early-close"]) test(`failed process-group cleanup ${mode} cannot succeed or delete the root`, native, async t => {
  const f = await fixture(t);
  const module = new URL("../dist/runtime/acp/host-terminal-process.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import {ChildProcess} from "node:child_process";
    import {access,rm} from "node:fs/promises";
    import {setTimeout as delay} from "node:timers/promises";
    import {startBoundedHostTerminal} from ${JSON.stringify(module)};
    const cwd = ${JSON.stringify(f.workspaceRoot)};
    const originalKill = process.kill.bind(process);
    const originalChildKill = ChildProcess.prototype.kill;
    const mode = ${JSON.stringify(mode)};
    let terminal;
    try {
      terminal = await startBoundedHostTerminal({ workspaceRoot:cwd,cwd,executable:"/bin/sh",
        args:["-c",mode === "signal-error" ? 'printf ready; exec /bin/sleep 30'
          : '/bin/sleep 30 ' + (mode === "early-close" ? '>/dev/null 2>&1 ' : '') + '& printf "%s" "$!"; /bin/sleep 0.1; exit 7'],
        policyProfileId:"workspace_write",allowedWritePaths:[cwd],signal:new AbortController().signal });
      process.send({ownedGroup:terminal.pid,root:terminal.operationRoot});
      process.kill = (pid,signal) => {
        if (pid === -terminal.pid && signal === "SIGKILL") {
          const error = new Error("Owned test group denied");error.code="EPERM";throw error;
        }
        return originalKill(pid,signal);
      };
      if(mode === "signal-error") ChildProcess.prototype.kill = function(signal) {
        if(this.pid === terminal.pid && signal === "SIGKILL") {
          this.emit("error",Object.assign(new Error("Owned child kill denied"),{code:"EPERM"}));return false;
        }
        return originalChildKill.call(this,signal);
      };
      await assert.rejects(mode === "signal-error" ? terminal.kill() : terminal.waitForExit(),{code:"terminal_cleanup_failed"});
      await delay(30);
      await assert.rejects(terminal.dispose(),{code:"terminal_cleanup_failed"});
      await assert.rejects(terminal.dispose(),{code:"terminal_cleanup_failed"});
      await access(terminal.operationRoot);
    } finally {
      process.kill=originalKill;
      ChildProcess.prototype.kill=originalChildKill;
      if(terminal){
        try{originalKill(-terminal.pid,"SIGKILL");}catch(error){if(error.code!=="ESRCH")throw error;}
        await delay(30);await rm(terminal.operationRoot,{recursive:true,force:true});
      }
      if(process.connected)process.disconnect();
    }
  `], { env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const closed = once(child, "close");
  let owned, stderr = "";
  child.on("message", message => { owned = message; });
  child.stdout.resume(); child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  t.after(async () => {
    clearTimeout(deadline); child.kill("SIGKILL");
    if (owned) {
      try { process.kill(-owned.ownedGroup, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await rm(owned.root, { recursive: true, force: true });
    }
  });
  const [code, signal] = await closed;
  clearTimeout(deadline);
  assert.equal(signal, null, stderr);
  assert.equal(code, 0, stderr);
});
