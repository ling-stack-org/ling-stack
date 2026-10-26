import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const entryUrl = new URL("../scripts/package-macos-with-office.mjs", import.meta.url);
const configUrl = new URL("../scripts/cua-driver-electron-builder.config.mjs", import.meta.url);
const builderArguments = Object.freeze(["--mac", "dmg", "zip", "--arm64"]);
const expectedBuilderArgs = ["--config", fileURLToPath(configUrl), ...builderArguments];
// Independent contract cases, not imported from the production admission helper.
const signingEnvironmentKeys = Object.freeze([
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD",
  "CSC_KEYCHAIN", "CSC_NAME", "CSC_FOR_PULL_REQUEST", "CSC_IDENTITY_AUTO_DISCOVERY",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY",
  "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE",
]);
const secretSentinel = "explicit-test-only-signing-secret-must-not-appear-in-errors";
const keys = Object.freeze({
  existing: "LING_OFFICE_FIXED_ENTRY_TEST_EXISTING",
  missing: "LING_OFFICE_FIXED_ENTRY_TEST_MISSING",
  removed: "LING_OFFICE_FIXED_ENTRY_TEST_REMOVED",
  omitted: "LING_OFFICE_FIXED_ENTRY_TEST_OMITTED",
});
let sequence = 0;

function deferred() {
  let settle;
  const promise = new Promise((resolvePromise) => { settle = resolvePromise; });
  return { promise, settle };
}

function seedEnvironment(t, values) {
  const originals = Object.keys(values).map((key) => ({
    key, existed: Object.hasOwn(process.env, key), value: process.env[key],
  }));
  t.after(() => {
    for (const { key, existed, value } of originals) {
      if (existed) process.env[key] = value;
      else delete process.env[key];
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertRestored() {
  assert.equal(process.env[keys.existing], "before");
  assert.equal(Object.hasOwn(process.env, keys.missing), false);
  assert.equal(process.env[keys.removed], "remove-before");
  assert.equal(process.env[keys.omitted], "untouched-before");
  assert.equal(Object.hasOwn(process.env, "LING_CUA_DRIVER_PACKAGE_PROVIDER"), false);
  assert.equal(Object.hasOwn(process.env, "CSC_FOR_PULL_REQUEST"), false);
}

/**
 * Explicit test-only ESM loader: native publication, active binding, Cua CLI,
 * config and electron-builder are synthetic. The entry source and its real
 * withCuaDriverBuilderEnvironment helper are unchanged; no package is built.
 */
async function fixture(t, options = {}) {
  seedEnvironment(t, {
    ...Object.fromEntries(signingEnvironmentKeys.map(key => [key, undefined])),
    [keys.existing]: "before", [keys.missing]: undefined,
    [keys.removed]: "remove-before", [keys.omitted]: "untouched-before",
    LING_CUA_DRIVER_PACKAGE_PROVIDER: undefined,
    LING_DESKTOP_PACKAGE_HUMAN_QA: undefined,
  });
  for (const [key, value] of [["platform", options.platform ?? "darwin"], ["arch", options.arch ?? "arm64"]]) {
    const original = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { ...original, value });
    t.after(() => Object.defineProperty(process, key, original));
  }
  const marker = `__officeFixedEntryTestOnly${++sequence}`;
  const state = {
    options, audit: [], configUrls: [], buildCalls: [], tokens: [], active: undefined,
    configEntered: deferred(), builderEntered: deferred(), pid: process.pid,
    environment: Object.freeze({
      [keys.existing]: "during", [keys.missing]: "temporary", [keys.removed]: undefined,
      LING_CUA_DRIVER_PACKAGE_PROVIDER: "0",
      ...options.derivedEnvironment,
    }),
    failure: new Error("explicit_test_only_fixed_entry_failure"),
    fail(stage) { if (options.failAt === stage) throw this.failure; },
    assertScope(active) {
      assert.equal(process.pid, this.pid);
      for (const [key, value] of Object.entries(this.environment)) {
        if (value === undefined) assert.equal(Object.hasOwn(process.env, key), false);
        else assert.equal(process.env[key], value);
      }
      assert.equal(process.env[keys.omitted], "untouched-before");
      assert.equal(Boolean(this.active), active);
    },
    profile() {
      this.audit.push("profile"); this.fail("profile");
      return { signingTier: options.signingTier ?? "unsigned_dev" };
    },
    async cli(values, environment, dependencies) {
      this.audit.push("cli-enter");
      assert.equal(process.pid, this.pid);
      assert.equal(environment, process.env);
      assert.deepEqual(values, ["--platform", "darwin", "--", ...builderArguments]);
      assert.deepEqual(Object.keys(dependencies), ["runBuilder"]);
      this.fail("cli");
      await options.onCli?.();
      try {
        const result = await dependencies.runBuilder({
          appRoot: options.appRoot ?? desktopRoot,
          args: options.builderArgs ?? expectedBuilderArgs,
          environment: this.environment,
        });
        assert.equal(result, 0);
        this.audit.push("cli-completed");
      } finally { this.audit.push("cli-finally"); }
    },
    async daemon() {
      this.audit.push("daemon"); this.assertScope(false); this.fail("daemon");
      const token = Object.freeze({}); this.tokens.push(token); return token;
    },
    async publication(token, operation) {
      this.audit.push("publication-enter"); this.assertScope(false);
      assert.equal(token, this.tokens.at(-1)); this.fail("publication-enter");
      this.active = token;
      try { return await operation(); }
      finally {
        this.active = undefined; this.audit.push("publication-finally");
        this.fail("publication-close");
      }
    },
    async config(originalUrl) {
      this.audit.push("config-enter"); this.assertScope(true);
      assert.equal(Object.hasOwn(process.env, "CSC_FOR_PULL_REQUEST"), false);
      this.configUrls.push(originalUrl); this.configEntered.settle();
      await (options.configGate?.promise ?? Promise.resolve());
      this.assertScope(true); this.fail("config"); this.audit.push("config-completed");
      await options.onConfig?.();
      return { ...options.topLevelConfig, mac: options.macConfig ?? { identity: "-" },
        testOnly: { pid: process.pid, token: this.active } };
    },
    targets(names, arch) {
      this.assertScope(true);
      assert.deepEqual(names, ["dmg", "zip"]); assert.equal(arch, "explicit-test-only-arm64");
      this.audit.push("targets");
      return Object.freeze({ explicitTestOnlyTargets: names, arch });
    },
    async build(input) {
      this.audit.push("build-enter"); this.assertScope(true); this.buildCalls.push(input);
      assert.equal(process.env.CSC_FOR_PULL_REQUEST, "true");
      assert.deepEqual(Object.keys(input).sort(), ["config", "projectDir", "publish", "targets"]);
      assert.equal(input.projectDir, desktopRoot); assert.equal(input.publish, "never");
      assert.equal(input.config.testOnly.pid, process.pid); assert.equal(input.config.testOnly.token, this.active);
      assert.deepEqual(input.targets, { explicitTestOnlyTargets: ["dmg", "zip"], arch: "explicit-test-only-arm64" });
      this.builderEntered.settle();
      await options.onBuild?.();
      await (options.builderGate?.promise ?? Promise.resolve());
      assert.equal(process.env.CSC_FOR_PULL_REQUEST, "true");
      this.assertScope(true); this.fail("builder"); this.audit.push("build-completed");
    },
  };
  Object.defineProperty(globalThis, marker, { configurable: true, value: state });
  t.after(() => { delete globalThis[marker]; });
  const shim = (body) => `data:text/javascript;base64,${Buffer.from(
    `const state = globalThis[${JSON.stringify(marker)}];\n${body}`,
  ).toString("base64")}`;
  const replacements = new Map([
    ["electron-builder", shim(`
      export const Arch = { arm64: "explicit-test-only-arm64" };
      export const Platform = { MAC: { createTarget: (...args) => state.targets(...args) } };
      export const build = (...args) => state.build(...args);
    `)],
    [new URL("../scripts/build-packaged-daemon.mjs", import.meta.url).href,
      shim("export const buildFreshPackagedDaemonForMacOffice = () => state.daemon();")],
    [new URL("../scripts/build-packaged-office-native.mjs", import.meta.url).href,
      shim("export const withOriginalPackagedOfficeNativePublication = (...args) => state.publication(...args);")],
    [new URL("../scripts/build-human-evaluation-helper.mjs", import.meta.url).href,
      shim("export const buildHumanEvaluationHelper = () => { state.assertScope(true); state.humanBuildCalls = (state.humanBuildCalls ?? 0) + 1; state.fail('human-helper'); return { testOnly: true }; };")],
    [new URL("../scripts/cua-driver-electron-package.mjs", import.meta.url).href,
      shim("export const runCuaDriverElectronPackageCli = (...args) => state.cli(...args);")],
    [new URL("../scripts/cua-driver-signing/signing-contract.mjs", import.meta.url).href,
      shim("export const resolveSigningProfile = () => state.profile();")],
  ]);
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL && new URL(context.parentURL).pathname === entryUrl.pathname) {
      const candidate = specifier === "electron-builder" ? specifier : new URL(specifier, context.parentURL).href;
      if (replacements.has(candidate)) return { url: replacements.get(candidate), shortCircuit: true };
      if (candidate.startsWith(configUrl.href + "?")) {
        return { url: shim(`export default await state.config(${JSON.stringify(candidate)});`), shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  const importEntry = (exact = false) => import(exact ? entryUrl.href : `${entryUrl.href}?explicitTestOnly=${marker}`);
  return { state, options, importEntry, api: options.manualImport ? undefined : await importEntry() };
}

test("fixed Office package entry regression (test-only loader, no native/signature/package approval)", async t => {
  await t.test("QA uses the original publication/signing path with fixed separate identity", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack", directories: { output: "release" } },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "1";
    await f.api.packageMacosWithOffice();
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.humanBuildCalls, 1);
    assert.equal(f.state.buildCalls.length, 1);
    const { config } = f.state.buildCalls[0];
    assert.equal(config.appId, "com.lingstack.desktop.human-qa");
    assert.equal(config.productName, "Ling Stack Human QA");
    assert.equal(config.directories.output, "release/human-qa");
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.sign, undefined);
    assert.equal(config.extraMetadata.lingHumanQaPackage.release, false);
    assert.equal(f.state.active, undefined);
  });

  await t.test("invalid QA selector refuses before CLI/native/build", async t => {
    const f = await fixture(t);
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "0";
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_lane_invalid/u);
    assert.deepEqual(f.state.audit, []);
    assert.equal(f.state.tokens.length, 0);
    assert.equal(f.state.buildCalls.length, 0);
  });

  await t.test("retained-host successor keeps original publication, ad-hoc signer and no-publish path", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03" },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack", directories: { output: "release" } },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "retained-host-r03";
    await f.api.packageMacosWithOffice();
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.humanBuildCalls, 1);
    assert.equal(f.state.buildCalls.length, 1);
    const { config } = f.state.buildCalls[0];
    assert.equal(config.appId, "com.lingstack.desktop.human-qa.r03-successor");
    assert.equal(config.productName, "Ling Stack R03 Successor QA");
    assert.equal(config.directories.output, "release/human-qa-r03-successor");
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.sign, undefined);
    assert.equal(config.extraMetadata.lingHumanQaPackage.release, false);
    assert.equal(f.state.active, undefined);
  });

  await t.test("retained-host observation uses a third fixed identity through the original publication and signing path", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03-observation" },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack", directories: { output: "release" } },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "retained-host-r03-observation";
    await f.api.packageMacosWithOffice();
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.humanBuildCalls, 1);
    assert.equal(f.state.buildCalls.length, 1);
    const { config } = f.state.buildCalls[0];
    assert.equal(config.appId, "com.lingstack.desktop.human-qa.r03-observation");
    assert.equal(config.productName, "Ling Stack R03 Observation QA");
    assert.equal(config.directories.output, "release/human-qa-r03-observation");
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.sign, undefined);
    assert.deepEqual(config.extraMetadata.lingHumanQaPackage, {
      schemaVersion: 1, purpose: "synthetic-human-evaluation", release: false,
    });
    assert.equal(f.state.active, undefined);
  });

  await t.test("integrated-main QA preserves original publication, signer, final hooks and no-publish path", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "integrated-main" },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack", directories: { output: "release" } },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "integrated-main";
    await f.api.packageMacosWithOffice();
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.humanBuildCalls, 1);
    assert.equal(f.state.buildCalls.length, 1);
    const { config } = f.state.buildCalls[0];
    assert.equal(config.appId, "com.lingstack.desktop.human-qa.integrated-main");
    assert.equal(config.productName, "Ling Stack Integrated Main QA");
    assert.equal(config.directories.output, "release/human-qa-integrated-main");
    assert.equal(config.mac.identity, "-");
    assert.equal(config.mac.sign, undefined);
    assert.equal(config.extraMetadata.lingHumanQaPackage.release, false);
    assert.equal(f.state.active, undefined);
  });

  await t.test("integrated-main and every retained lane reject derived or config-time identity substitution", async t => {
    for (const retained of ["1", "retained-host-r03", "retained-host-r03-observation"]) {
      for (const [admitted, replacement] of [["integrated-main", retained], [retained, "integrated-main"]]) {
        await t.test(`${admitted} to ${replacement} before native`, async t => {
          const f = await fixture(t, { derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: replacement } });
          process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = admitted;
          await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
          assert.equal(f.state.tokens.length, 0);
          assert.equal(f.state.buildCalls.length, 0);
        });
        await t.test(`${admitted} to ${replacement} after config`, async t => {
          const f = await fixture(t, {
            derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: admitted },
            onConfig: () => { process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = replacement; },
            topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack" },
          });
          process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = admitted;
          await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
          assert.equal(f.state.tokens.length, 1);
          assert.equal(f.state.buildCalls.length, 0);
          assert.equal(f.state.active, undefined);
        });
      }
    }
  });

  await t.test("derived environment cannot replace the observation lane with a retained successor", async t => {
    const f = await fixture(t, { derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03" } });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "retained-host-r03-observation";
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 0);
    assert.equal(f.state.buildCalls.length, 0);
  });

  await t.test("config-time switching into observation closes publication without Builder", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" },
      onConfig: () => { process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "retained-host-r03-observation"; },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack" },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "1";
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.buildCalls.length, 0);
    assert.equal(f.state.active, undefined);
  });

  await t.test("derived environment cannot switch between two QA identities", async t => {
    const f = await fixture(t, { derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "retained-host-r03" } });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "1";
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 0);
    assert.equal(f.state.buildCalls.length, 0);
  });

  await t.test("config-time switching QA identities closes publication without Builder", async t => {
    const f = await fixture(t, {
      derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" },
      onConfig: () => { process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "retained-host-r03"; },
      topLevelConfig: { appId: "com.lingstack.desktop", productName: "Ling Stack" },
    });
    process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "1";
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.buildCalls.length, 0);
    assert.equal(f.state.active, undefined);
  });

  await t.test("derived environment cannot change the admitted lane", async t => {
    const f = await fixture(t, { derivedEnvironment: { LING_DESKTOP_PACKAGE_HUMAN_QA: "1" } });
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 0);
    assert.equal(f.state.buildCalls.length, 0);
  });

  await t.test("config-time lane drift refuses Builder and closes publication", async t => {
    const f = await fixture(t, { onConfig: () => { process.env.LING_DESKTOP_PACKAGE_HUMAN_QA = "1"; } });
    await assert.rejects(f.api.packageMacosWithOffice(), /human_qa_selection_changed/u);
    assert.equal(f.state.tokens.length, 1);
    assert.equal(f.state.buildCalls.length, 0);
    assert.equal(f.state.active, undefined);
  });

  await t.test("same-process config import and Builder stay awaited inside real environment scope", async t => {
    const configGate = deferred(), builderGate = deferred();
    const f = await fixture(t, { configGate, builderGate });
    assert.deepEqual(Object.keys(f.api), ["packageMacosWithOffice"]);
    let settled = false;
    const pending = f.api.packageMacosWithOffice().finally(() => { settled = true; });
    try {
      await f.state.configEntered.promise;
      f.state.assertScope(true); assert.equal(settled, false);
      configGate.settle(); await f.state.builderEntered.promise;
      f.state.assertScope(true); assert.equal(settled, false);
      await assert.rejects(f.api.packageMacosWithOffice(), /package_busy/u);
      assert.equal(f.state.tokens.length, 1);
    } finally { configGate.settle(); builderGate.settle(); await pending; }
    assert.equal(settled, true); assert.equal(f.state.active, undefined); assertRestored();
    assert.equal(f.state.humanBuildCalls, 1, "fixed human helper build belongs inside the approved publication scope");
    assert.deepEqual(f.state.audit, ["profile", "cli-enter", "daemon", "publication-enter", "config-enter",
      "config-completed", "targets", "build-enter", "build-completed", "publication-finally", "cli-completed", "cli-finally"]);
  });

  await t.test("sequential invocations import fresh fixed config and ignore caller override objects", async t => {
    const f = await fixture(t);
    let inspected = false;
    const caller = { get config() { inspected = true; throw Error("caller_config_must_not_be_read"); } };
    await f.api.packageMacosWithOffice(caller);
    await f.api.packageMacosWithOffice({ targets: ["nsis"], publication: {}, environment: {} });
    assert.equal(inspected, false); assert.equal(f.state.buildCalls.length, 2);
    assert.notEqual(f.state.tokens[0], f.state.tokens[1]);
    assert.notEqual(f.state.buildCalls[0].config, f.state.buildCalls[1].config);
    assert.deepEqual(f.state.configUrls.map(url => new URL(url).searchParams.get("officeInvocation")), ["1", "2"]);
    for (const url of f.state.configUrls) assert.equal(new URL(url).pathname, configUrl.pathname);
    assertRestored();
  });

  await t.test("synchronous reentry from Builder rejects without a second native selection", async t => {
    const f = await fixture(t);
    f.options.onBuild = async () => {
      await assert.rejects(f.api.packageMacosWithOffice(), /package_busy/u);
      f.state.assertScope(true);
    };
    await f.api.packageMacosWithOffice();
    assert.equal(f.state.tokens.length, 1); assert.equal(f.state.buildCalls.length, 1); assertRestored();
  });

  for (const stage of ["profile", "cli", "daemon", "publication-enter", "human-helper", "config", "builder", "publication-close"]) {
    await t.test(`failure at ${stage} propagates, restores env and releases entry guard`, async t => {
      const f = await fixture(t, { failAt: stage });
      await assert.rejects(f.api.packageMacosWithOffice(), error => error === f.state.failure);
      assert.equal(f.state.active, undefined); assertRestored();
      f.options.failAt = undefined;
      await f.api.packageMacosWithOffice();
      assert.equal(f.state.active, undefined); assertRestored();
    });
  }

  for (const [name, options] of [
    ["non-macOS", { platform: "linux" }], ["non-arm64", { arch: "x64" }],
    ["internal signing", { signingTier: "test_signed_internal" }],
    ["distribution signing", { signingTier: "developer_id" }],
  ]) await t.test(`unsupported ${name} rejects before Cua/native/Builder`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.api.packageMacosWithOffice(), /package_profile_unsupported/u);
    await assert.rejects(f.api.packageMacosWithOffice(), /package_profile_unsupported/u);
    assert.equal(f.state.audit.includes("cli-enter"), false); assert.equal(f.state.tokens.length, 0); assertRestored();
  });

  await t.test("provider signing lane rejects and releases guard before Cua/native/Builder", async t => {
    const f = await fixture(t); process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER = "1";
    await assert.rejects(f.api.packageMacosWithOffice(), /provider_signing_lane_unsupported/u);
    assert.deepEqual(f.state.audit, ["profile"]); assert.equal(f.state.tokens.length, 0);
    delete process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER;
    await f.api.packageMacosWithOffice(); assertRestored();
  });

  for (const key of signingEnvironmentKeys) {
    for (const value of [secretSentinel, ""]) {
      await t.test(`ambient ${key} ${value === "" ? "empty presence" : "input"} rejects before Cua/native/Builder`, async t => {
        const f = await fixture(t);
        process.env[key] = value;
        await assert.rejects(f.api.packageMacosWithOffice(), error => {
          assert.match(error.message, /signing_inputs_unsupported/u);
          assert.ok(error.message.includes(key));
          assert.equal(error.message.includes(secretSentinel), false);
          return true;
        });
        assert.equal(process.env[key], value);
        assert.equal(f.state.audit.includes("cli-enter"), false);
        assert.equal(f.state.tokens.length, 0); assert.equal(f.state.buildCalls.length, 0);
        delete process.env[key];
        await f.api.packageMacosWithOffice(); await f.api.packageMacosWithOffice();
        assert.equal(f.state.buildCalls.length, 2); assertRestored();
      });
    }
    await t.test(`derived ${key} input rejects before native/Builder without sanitizing`, async t => {
      const f = await fixture(t, { derivedEnvironment: { [key]: secretSentinel } });
      await assert.rejects(f.api.packageMacosWithOffice(), error => {
        assert.match(error.message, /signing_inputs_unsupported/u);
        assert.ok(error.message.includes(key));
        assert.equal(error.message.includes(secretSentinel), false);
        return true;
      });
      assert.equal(f.state.environment[key], secretSentinel);
      assert.equal(Object.hasOwn(process.env, key), false);
      assert.equal(f.state.tokens.length, 0); assert.equal(f.state.buildCalls.length, 0);
      const cleanEnvironment = { ...f.state.environment };
      delete cleanEnvironment[key]; f.state.environment = Object.freeze(cleanEnvironment);
      await f.api.packageMacosWithOffice(); await f.api.packageMacosWithOffice();
      assert.equal(f.state.buildCalls.length, 2); assertRestored();
    });
  }

  for (const [stage, expectedNativeSelections] of [["onCli", 0], ["onConfig", 1]]) {
    await t.test(`signing input introduced at ${stage} is rechecked before its next side effect`, async t => {
      const f = await fixture(t, { [stage]: () => { process.env.CSC_KEYCHAIN = secretSentinel; } });
      await assert.rejects(f.api.packageMacosWithOffice(), /signing_inputs_unsupported/u);
      assert.equal(process.env.CSC_KEYCHAIN, secretSentinel);
      assert.equal(f.state.tokens.length, expectedNativeSelections);
      assert.equal(f.state.buildCalls.length, 0); assert.equal(f.state.active, undefined);
      delete process.env.CSC_KEYCHAIN; f.options[stage] = undefined;
      await f.api.packageMacosWithOffice(); await f.api.packageMacosWithOffice(); assertRestored();
    });
  }

  for (const [name, options] of [
    ["foreign app root", { appRoot: realpathSync(fileURLToPath(new URL("../../../", import.meta.url))) }],
    ["caller config", { builderArgs: ["--config", "/explicit-test-only/caller.mjs", ...builderArguments] }],
    ["extra config override", { builderArgs: [...expectedBuilderArgs, "--config.foo=bar"] }],
    ["caller architecture", { builderArgs: ["--config", fileURLToPath(configUrl), "--mac", "dmg", "zip", "--x64"] }],
  ]) await t.test(`Cua callback ${name} cannot override fixed invocation`, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.api.packageMacosWithOffice(), /builder_invocation_invalid/u);
    assert.equal(f.state.tokens.length, 0); assert.equal(f.state.configUrls.length, 0); assertRestored();
    f.options.appRoot = undefined; f.options.builderArgs = undefined;
    await f.api.packageMacosWithOffice(); assertRestored();
  });

  for (const [name, macConfig] of [
    ["custom signer", { identity: "-", sign: "explicit-test-only-noop-signer" }],
    ["non-adhoc identity", { identity: "explicit-test-only-identity" }],
  ]) await t.test(`config ${name} cannot bypass required default signer`, async t => {
    const f = await fixture(t, { macConfig });
    await assert.rejects(f.api.packageMacosWithOffice(), /default_signer_required/u);
    assert.equal(f.state.buildCalls.length, 0); assert.equal(f.state.active, undefined); assertRestored();
    f.options.macConfig = undefined;
    await f.api.packageMacosWithOffice(); assertRestored();
  });

  for (const [scope, fields] of [
    ["config", ["cscLink", "cscKeyPassword"]],
    ["mac", ["cscLink", "cscKeyPassword", "cscInstallerLink", "cscInstallerKeyPassword"]],
  ]) for (const field of fields) {
    for (const value of [secretSentinel, ""]) {
      await t.test(`${scope}.${field} ${value === "" ? "empty presence" : "input"} cannot bypass fixed unsigned signing`, async t => {
        const options = scope === "mac"
          ? { macConfig: { identity: "-", [field]: value } }
          : { topLevelConfig: { [field]: value } };
        const f = await fixture(t, options);
        await assert.rejects(f.api.packageMacosWithOffice(), error => {
          assert.match(error.message, /signing_inputs_unsupported/u);
          assert.ok(error.message.includes(`${scope}.${field}`));
          assert.equal(error.message.includes(secretSentinel), false);
          return true;
        });
        assert.equal(f.state.buildCalls.length, 0); assert.equal(f.state.active, undefined); assertRestored();
        f.options.macConfig = undefined; f.options.topLevelConfig = undefined;
        await f.api.packageMacosWithOffice(); await f.api.packageMacosWithOffice(); assertRestored();
      });
    }
  }

  for (const notarize of [true, { teamId: secretSentinel }]) {
    await t.test("explicit notarization cannot opt the fixed unsigned lane into another signing contract", async t => {
      const f = await fixture(t, { macConfig: { identity: "-", notarize } });
      await assert.rejects(f.api.packageMacosWithOffice(), error => {
        assert.match(error.message, /signing_inputs_unsupported/u);
        assert.ok(error.message.includes("mac.notarize"));
        assert.equal(error.message.includes(secretSentinel), false);
        return true;
      });
      assert.equal(f.state.buildCalls.length, 0); assertRestored();
      f.options.macConfig = { identity: "-", notarize: false };
      await f.api.packageMacosWithOffice(); await f.api.packageMacosWithOffice(); assertRestored();
    });
  }

  await t.test("CLI config override arguments reject before any package operation", async t => {
    const f = await fixture(t, { manualImport: true });
    const originalArgv = process.argv;
    t.after(() => { process.argv = originalArgv; });
    process.argv = [process.execPath, fileURLToPath(entryUrl), "--config=/explicit-test-only/caller.mjs"];
    await assert.rejects(f.importEntry(true), /package_arguments_invalid/u);
    assert.deepEqual(f.state.audit, []); assertRestored();
  });

  t.diagnostic("Only fixed-entry orchestration and the real awaited process.env scope are exercised. Native publication/active binding, config, Cua CLI and electron-builder are explicit test-only loader substitutes; no actual review approval, native build, codesign, Electron or packaged-app acceptance.");
});
