import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionEngineProfileStore, resolveUserConfigPaths } from "@ling-stack/core";
import { probeEngineConnection } from "../dist/features/execution-engines/connection-probe.js";
import { prepareNativeAuthHome } from "../dist/features/execution-engines/native-auth-home.js";

const native = { skip: process.platform !== "darwin", timeout: 10000 };
async function fixture(t, apiKey = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-kimi-probe-ownership-")));
  const paths = resolveUserConfigPaths({ userRootDir: join(root, "host") });
  const store = new ExecutionEngineProfileStore(paths), children = [], observations = [];
  t.after(async () => {
    for (const { child, closed, cwd } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      try { await chmod(join(cwd, "sealed"), 0o700); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rm(cwd, { recursive: true, force: true });
    }
    for (const { local } of observations) {
      for (const directory of ["logs", "logs/sealed"]) {
        try { await chmod(join(local, directory), 0o700); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await rm(local, { recursive: true, force: true });
    }
    store.close(); await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, "kimi");
  await writeFile(executable, Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.from("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1")]), { mode: 0o700 });
  const key = "synthetic-probe-api-key";
  const profile = store.save({ engineId: "kimi-acp", executablePath: executable, authProfileId: "fixture",
    ...(apiKey ? { secretRef: "env:KIMI_PROBE_TEST", kimi: { providerType: "kimi", baseUrl: "https://example.invalid/v1",
      modelId: "kimi-test", maxContextSize: 16384 } } : { kimiLoginRegion: "global" }) }, 0);
  const home = await prepareNativeAuthHome(paths, profile.configuration);
  const config = apiKey ? `default_model = "ling-default"
default_permission_mode = "manual"
telemetry = false
merge_all_available_skills = false
[providers.ling]
type = "kimi"
base_url = "https://example.invalid/v1"
api_key = "${key}"
[models.ling-default]
provider = "ling"
model = "kimi-test"
max_context_size = 16384
` : '[providers.test]\ntype = "kimi"\n[providers.test.oauth]\nstorage = "file"\nkey = "oauth/test"\n';
  const token = JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh" });
  await writeFile(join(home, "config.toml"), config, { mode: 0o600 });
  await mkdir(join(home, "credentials"), { mode: 0o700 });
  await writeFile(join(home, "credentials", "test.json"), token, { mode: 0o600 });
  const run = (testOptions = {}) => probeEngineConnection(profile, paths, { store, signal: testOptions.signal, platform: testOptions.platform,
    secretResolver: { resolve: () => ({ configured: true, value: key }) }, spawn: (file, args, options) => {
    const wrapped = file === "/usr/bin/sandbox-exec";
    let program = 'console.log("0.1.0-alpha.4")';
    if (wrapped || args[0] === "acp") {
      testOptions.onNativeSpawn?.();
      program = `
      const fs = require('node:fs'), path = require('node:path');
      const answer = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
      require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
        const request = JSON.parse(line);
        if (request.method === 'initialize') answer(request.id, { protocolVersion: 1,
          agentInfo: { name: 'Kimi Code CLI', version: '0.1.0-alpha.4' }, agentCapabilities: {}, authMethods: [{ id: 'login', type: 'terminal', name: 'Login', args: ['--login'] }] });
        if (request.method === 'authenticate') {
          const local = process.env.KIMI_CODE_HOME;
          let before;
          try { before = fs.readFileSync(path.join(local, 'credentials/test.json'), 'utf8'); } catch {}
          const keyConfigured = ${apiKey} && fs.readFileSync(path.join(local, 'config.toml'), 'utf8').includes(${JSON.stringify(key)});
          const denied = [];
          for (const target of [path.join(local, 'config.toml'), path.join(local, 'credentials/test.json'),
            ${JSON.stringify(join(home, "config.toml"))}, ${JSON.stringify(join(home, "credentials", "test.json"))}]) {
            try { fs.appendFileSync(target, '\\nchanged'); denied.push(false); } catch { denied.push(true); }
          }
          const attempt = action => { try { action(); return false; } catch { return true; } };
          const originals = [${JSON.stringify(join(home, "config.toml"))}, ${JSON.stringify(join(home, "credentials", "test.json"))},
            ${JSON.stringify(join("/System/Volumes/Data", home, "config.toml"))}];
          const hidden = originals.map(target => attempt(() => fs.readFileSync(target)));
          const metadataHidden = originals.map(target => attempt(() => fs.statSync(target)));
          const renameDenied = attempt(() => fs.renameSync(path.join(local, 'config.toml'), path.join(process.cwd(), 'stolen-config')));
          const parentRenameDenied = attempt(() => fs.renameSync(local, path.join(process.cwd(), 'stolen-home')));
          const unreferencedHidden = attempt(() => fs.readFileSync(path.join(local, 'credentials/unreferenced.json')));
          const scratch = path.join(local, 'logs', 'probe.txt'); fs.writeFileSync(scratch, 'ephemeral');
          if (${testOptions.lockedScratch === true}) {
            for (const sealed of [path.join(local, 'logs', 'sealed'), path.join(process.cwd(), 'sealed')]) {
              fs.mkdirSync(sealed);
              fs.writeFileSync(path.join(sealed, 'credential-copy'), before);
              fs.symlinkSync(${JSON.stringify(root)}, path.join(sealed, 'outside'));
              fs.chmodSync(sealed, 0);
            }
            fs.chmodSync(path.join(local, 'logs'), 0);
          }
          let networkDenied;
          if (${testOptions.port ?? 0}) networkDenied = await new Promise(resolve => {
            const socket = require('node:net').createConnection({ host: '127.0.0.1', port: ${testOptions.port ?? 0} });
            socket.on('connect', () => { socket.destroy(); resolve(false); });
            socket.on('error', error => resolve(['EPERM', 'EACCES'].includes(error.code)));
            socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
          });
          process.send({ before, keyConfigured, denied, local, hidden, metadataHidden, renameDenied, parentRenameDenied, unreferencedHidden, networkDenied });
          if (${testOptions.pending === true}) return;
          if (before === undefined && !keyConfigured) console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'required' } }));
          else answer(request.id, {});
        }
      });
      setInterval(() => {}, 1000);
    `;
    }
    const node = join(options.cwd, "fixture-node");
    copyFileSync(process.execPath, node);
    const child = spawn(wrapped ? file : node, wrapped ? [...args.slice(0, 2), node, "-e", program] : ["-e", program],
      { ...options, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    child.on("message", value => { observations.push(value); testOptions.onObservation?.(); });
    children.push({ child, closed: once(child, "close"), cwd: options.cwd });
    return child;
  } });
  return { run, root, paths, store, profile, home, config, token, observations, children };
}

test("Kimi connection check cannot overwrite adopted configuration or credentials", native, async t => {
  const { run, home, config, token, children, observations, store, profile } = await fixture(t);
  await writeFile(join(home, "credentials", "unreferenced.json"), "must-not-copy");
  const result = await run();
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(children.length, 2);
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), config, "connection check must not change adopted configuration");
  assert.equal(readFileSync(join(home, "credentials", "test.json"), "utf8"), token);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].before, token);
  assert.deepEqual(observations[0].denied, [true, true, true, true]);
  assert.notEqual(observations[0].local, home);
  assert.deepEqual(observations[0].hidden, [true, true, true]);
  assert.deepEqual(observations[0].metadataHidden, [true, true, true]);
  assert.equal(observations[0].renameDenied, true);
  assert.equal(observations[0].parentRenameDenied, true);
  assert.equal(observations[0].unreferencedHidden, true);
  await assert.rejects(readFile(join(observations[0].local, "logs", "probe.txt")), { code: "ENOENT" });
  assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  assert.deepEqual(store.get("kimi-acp"), profile);
});

test("Kimi probe removes mode-000 credential scratch without following its external symlink", native, async t => {
  const f = await fixture(t);
  const rootMode = (await lstat(f.root)).mode;
  const result = await f.run({ lockedScratch: true });
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(f.observations.length, 1);
  await assert.rejects(readFile(join(f.observations[0].local, "config.toml")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.home, "credentials", "test.json"), "utf8"), f.token);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), f.config);
  assert.ok(f.children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  assert.equal((await lstat(f.root)).mode, rootMode);
  for (const { cwd } of f.children) await assert.rejects(lstat(cwd), { code: "ENOENT" });
});

test("Kimi API-key connection reads only its read-only native snapshot", native, async t => {
  const f = await fixture(t, true);
  const result = await f.run();
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(result.authentication, "configured_unverified");
  assert.equal(f.observations[0].keyConfigured, true);
  assert.equal(f.observations[0].before, undefined, "an unreferenced OAuth token is not copied into key authentication");
  assert.deepEqual(f.observations[0].denied, [true, true, true, true]);
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), f.config);
  await assert.rejects(lstat(f.observations[0].local), { code: "ENOENT" });
});

for (const platform of ["linux", "win32"]) {
  test(`Kimi connection probe refuses unsupported ${platform} without starting a native process`, async t => {
    const f = await fixture(t);
    const result = await f.run({ platform });
    assert.equal(result.status, "unsupported_platform");
    assert.equal(result.authentication, "not_checked");
    assert.equal(result.connection, "not_checked");
    assert.equal(f.children.length, 0);
  });
}

test("Kimi connection diagnostic cannot reach an observed live loopback server", native, async t => {
  const f = await fixture(t);
  let accepted = 0;
  const server = createServer(socket => { accepted++; socket.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const baseline = connect({ host: "127.0.0.1", port });
  await once(baseline, "close");
  assert.equal(accepted, 1);
  const result = await f.run({ port });
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(f.observations[0].networkDenied, true);
  assert.equal(accepted, 1);
});

for (const scenario of ["symlink-config", "hardlink-slot", "symlink-parent", "traversal", "malformed", "oversize"]) {
  test(`Kimi probe rejects ${scenario} before reading it in a native process`, native, async t => {
    const f = await fixture(t), config = join(f.home, "config.toml"), slot = join(f.home, "credentials", "test.json");
    if (scenario === "symlink-config") {
      await rename(config, join(f.root, "outside.toml")); await symlink(join(f.root, "outside.toml"), config);
    } else if (scenario === "hardlink-slot") await link(slot, join(f.root, "outside.json"));
    else if (scenario === "symlink-parent") {
      await rename(join(f.home, "credentials"), join(f.root, "outside-credentials"));
      await symlink(join(f.root, "outside-credentials"), join(f.home, "credentials"));
    } else await writeFile(config, scenario === "traversal" ? f.config.replace("oauth/test", "../outside")
      : scenario === "malformed" ? "invalid [ TOML" : "#".repeat(65537));
    const result = await f.run();
    assert.equal(result.status, "auth_required", JSON.stringify(result));
    assert.equal(result.errorCode, "engine_native_auth_invalid");
    assert.equal(f.children.length, 1, "only the installation identity check runs");
    assert.deepEqual(f.observations, []);
  });
}

for (const scenario of ["config", "credential", "profile", "new-missing-slot", "credential-parent"]) {
  test(`Kimi probe rejects a changed ${scenario} before accepting its diagnostic`, native, async t => {
    const f = await fixture(t);
    if (scenario === "new-missing-slot") await rm(join(f.home, "credentials", "test.json"));
    const result = await f.run({ onNativeSpawn: () => {
      if (scenario === "profile") f.store.disconnect("kimi-acp", f.profile.revision);
      else if (scenario === "credential-parent") {
        const fs = process.getBuiltinModule("fs");
        fs.renameSync(join(f.home, "credentials"), join(f.home, "old-credentials"));
        fs.mkdirSync(join(f.home, "credentials"), { mode: 0o700 });
        fs.writeFileSync(join(f.home, "credentials", "test.json"), f.token, { mode: 0o600 });
      }
      else {
        const target = scenario === "config" ? join(f.home, "config.toml") : join(f.home, "credentials", "test.json");
        // This is an independent host writer, not a child sandbox bypass.
        const fs = process.getBuiltinModule("fs");
        fs.writeFileSync(target, "changed-by-host", { mode: 0o600 });
      }
    } });
    assert.notEqual(result.status, "connected", JSON.stringify(result));
    assert.equal(f.children.length, 2);
    assert.ok(f.children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
    await assert.rejects(readFile(join(f.observations[0].local, "config.toml")), { code: "ENOENT" });
  });
}

test("Kimi missing credential stays missing and reports authentication required", native, async t => {
  const f = await fixture(t);
  await rm(join(f.home, "credentials", "test.json"));
  const result = await f.run();
  assert.equal(result.status, "connected", JSON.stringify(result));
  assert.equal(result.authentication, "required");
  await assert.rejects(readFile(join(f.home, "credentials", "test.json")), { code: "ENOENT" });
});

for (const count of [64, 65]) {
  test(`Kimi probe validates the ${count}-slot credential reference boundary`, native, async t => {
    const f = await fixture(t);
    await writeFile(join(f.home, "config.toml"), Array.from({ length: count }, (_, i) =>
      `[providers.test${i}.oauth]\nstorage = "file"\nkey = "oauth/slot${i}"\n`).join("\n"));
    const result = await f.run();
    if (count === 65) {
      assert.equal(result.status, "auth_required", JSON.stringify(result));
      assert.equal(result.errorCode, "engine_native_auth_invalid");
      assert.equal(f.children.length, 1);
    } else {
      assert.equal(result.status, "connected", JSON.stringify(result));
      assert.equal(result.authentication, "required");
      assert.equal(f.children.length, 2);
    }
  });
}

test("cancelling a Kimi snapshot probe reaps its process and removes only temporary auth", native, async t => {
  const f = await fixture(t), abort = new AbortController();
  const result = await f.run({ signal: abort.signal, pending: true, onObservation: () => abort.abort() });
  assert.equal(result.status, "cancelled", JSON.stringify(result));
  assert.ok(f.children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
  assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), f.config);
  await assert.rejects(readFile(join(f.observations[0].local, "config.toml")), { code: "ENOENT" });
});
