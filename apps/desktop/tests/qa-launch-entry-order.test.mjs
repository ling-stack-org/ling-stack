import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const entry = new URL("../dist/main/entry.js", import.meta.url);
let sequence = 0;

/** Real emitted entry/QA leaf; synthetic Electron/Main. No GUI, Store or human confirmation. */
async function fixture(t, { qa = true, profileArgument = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-human-qa-entry-order-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, "profile"), appPath = join(root, "app");
  mkdirSync(profile, { mode: 0o700 }); mkdirSync(appPath, { mode: 0o700 });
  for (const name of ["workspace", "ling-home", "user-data"]) mkdirSync(join(profile, name), { mode: 0o700 });
  const marker = { schemaVersion: 1, kind: "synthetic-human-qa-profile", synthetic: true,
    modelExecution: false, humanConfirmation: false, workspaceCwd: join(profile, "workspace"),
    userDataDir: join(profile, "user-data"), lingHome: join(profile, "ling-home") };
  writeFileSync(join(profile, "qa-profile.json"), JSON.stringify(marker), { mode: 0o600 });
  writeFileSync(join(appPath, "package.json"), JSON.stringify({ name: "synthetic-entry-test-only",
    ...(qa ? { lingHumanQaPackage: { schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false } } : {}) }), { mode: 0o600 });
  const originalArgv = process.argv, originalEnvironment = { ...process.env }, originalInfo = console.info;
  const restore = () => {
    process.argv = originalArgv; console.info = originalInfo;
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(originalEnvironment, name)) delete process.env[name];
    for (const [name, value] of Object.entries(originalEnvironment)) process.env[name] = value;
  };
  t.after(restore);
  process.argv = [process.execPath, appPath, ...(profileArgument ? [`--ling-desktop-owned-qa-profile=${profile}`] : [])];
  process.env.LING_QA_ENTRY_TEST_PROVIDER_SECRET = "explicit-synthetic-only";
  process.env.LING_STACK_HOME = "/explicit-synthetic-daily-home";
  process.env.LING_STACK_DAEMON_URL = "http://127.0.0.1:1";
  const before = JSON.stringify(process.env);
  const key = `__qaEntryOrderExplicitTestOnly${++sequence}`;
  const state = { mainImports: 0, setCalls: 0, userData: "/synthetic-daily-user-data", marker, appPath, scopeLogs: 0,
    app: { isPackaged: true, getAppPath: () => appPath, getPath: () => state.userData,
      setPath: (name, value) => { assert.equal(name, "userData"); state.setCalls++; state.userData = value; } },
    mainImported() {
      state.mainImports++;
      if (qa) {
        assert.equal(state.setCalls, 1);
        assert.equal(state.userData, marker.userDataDir);
        assert.equal(process.env.LING_STACK_HOME, marker.lingHome);
        assert.equal(process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, marker.workspaceCwd);
        assert.equal(process.env.LING_STACK_DAEMON_URL, "http://127.0.0.1:17928");
        assert.equal(process.env.LING_STACK_HARNESS_CONTINUATIONS_MODE, "enforce");
        assert.equal(process.env.LING_STACK_LOCAL_WS_RPC, "false");
        assert.equal(process.env.LING_QA_ENTRY_TEST_PROVIDER_SECRET, undefined);
        assert.equal(state.scopeLogs, 1);
      } else {
        assert.equal(state.setCalls, 0);
        assert.equal(JSON.stringify(process.env) === before, true, "normal process environment must remain untouched");
        assert.equal(state.scopeLogs, 0);
      }
    },
  };
  console.info = value => {
    const record = JSON.parse(value);
    assert.equal(record.event, "desktop.owned_synthetic_qa_profile");
    assert.equal(record.synthetic, true);
    assert.equal(Object.hasOwn(record, "humanConfirmation"), false);
    assert.equal(Object.hasOwn(record, "secret"), false);
    state.scopeLogs++;
  };
  globalThis[key] = state;
  t.after(() => { delete globalThis[key]; });
  const shim = body => `data:text/javascript,${encodeURIComponent(`const state = globalThis[${JSON.stringify(key)}]; ${body}`)}`;
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL && new URL(context.parentURL).pathname === entry.pathname) {
      if (specifier === "electron") return { shortCircuit: true, url: shim("export const app = state.app;") };
      if (specifier === "./main.js") return { shortCircuit: true, url: shim("state.mainImported(); export {};") };
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  return { state, load: () => import(`${entry.href}?explicitTestOnly=${key}`) };
}

test("real emitted entry scopes actual process before dynamic Main evaluation", async t => {
  const f = await fixture(t);
  await f.load();
  assert.equal(f.state.mainImports, 1);
});

test("real emitted normal entry preserves inherited configuration and userData", async t => {
  const f = await fixture(t, { qa: false, profileArgument: false });
  await f.load();
  assert.equal(f.state.mainImports, 1);
});

test("QA package without profile never evaluates Main or falls back to daily profile", async t => {
  const f = await fixture(t, { profileArgument: false });
  await assert.rejects(f.load(), /desktop_qa_profile_required/u);
  assert.equal(f.state.mainImports, 0);
  assert.equal(f.state.setCalls, 0);
});
