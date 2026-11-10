import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const scriptsUrl = new URL("../scripts/", import.meta.url);
const originalHooksUrl = new URL("cua-driver-signing/hooks.mjs", scriptsUrl).href;
const roles = Object.freeze(["after-pack", "after-sign", "artifact-build-completed"]);
let sequence = 0;

function deferred() {
  let settle;
  const promise = new Promise(resolve => { settle = resolve; });
  return { promise, settle };
}

function seedEnvironment(t) {
  const keys = ["LING_CUA_DRIVER_PACKAGE_PROVIDER", "LING_CUA_PACKAGE_HOST_AUTHORITY_JSON",
    "LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256"];
  const previous = keys.map(key => ({ key, existed: Object.hasOwn(process.env, key), value: process.env[key] }));
  t.after(() => {
    for (const { key, existed, value } of previous) {
      if (existed) process.env[key] = value;
      else delete process.env[key];
    }
  });
  for (const key of keys) delete process.env[key];
}

/**
 * Load unchanged real wrappers with explicit synthetic Office/Cua/signing seams.
 * The companion classifier always delegates to the unchanged real hooks helper;
 * legal companion tests additionally execute the real original Cua hook.
 */
async function fixture(t, options = {}) {
  seedEnvironment(t);
  const marker = `__officeHookWiringExplicitTestOnly${++sequence}`;
  const wrapperUrls = new Map(roles.map(role => [role,
    new URL(`cua-driver-signing/${role}.mjs?explicitTestOnly=${marker}`, scriptsUrl).href]));
  const checksUrl = new URL(`packaged-office-native-package-checks.mjs?explicitTestOnly=${marker}`, scriptsUrl).href;
  const state = {
    audit: [], calls: [], activeReads: 0, gates: {}, entered: {},
    failure: new Error("explicit_test_only_hook_failure"), rejectAt: undefined,
    results: Object.fromEntries(["cua-pack", "cua-sign", "cua-artifact", "mac-development",
      "office-pack", "office-sign", "office-artifact"].map(role => [role,
      Object.freeze({ explicitTestOnly: true, role, skipped: role.startsWith("cua-") })])),
    extractor: () => { throw new Error("explicit_test_only_extractor_must_not_run"); },
    async operation(role, context, callOptions) {
      this.audit.push(role + ":enter"); this.calls.push({ role, context, callOptions });
      this.entered[role]?.settle();
      if (options.forbidOffice && role.startsWith("office-")) {
        throw new Error("explicit_test_only_companion_must_not_enter_office");
      }
      await (this.gates[role]?.promise ?? Promise.resolve());
      if (this.rejectAt === role) throw this.failure;
      this.audit.push(role + ":completed"); return this.results[role];
    },
  };
  Object.defineProperty(globalThis, marker, { configurable: true, value: state });
  t.after(() => { delete globalThis[marker]; });
  const shim = source => "data:text/javascript," + encodeURIComponent(
    `const state = globalThis[${JSON.stringify(marker)}];\n${source}`);
  const hooksShim = shim(`
    import * as original from ${JSON.stringify(originalHooksUrl)};
    export const isCompanionBlockmap = context => original.isCompanionBlockmap(context);
    export const runAfterPack = (...args) => state.operation("cua-pack", ...args);
    export const runAfterSign = (...args) => state.operation("cua-sign", ...args);
    export const runArtifactBuildCompleted = (...args) => state.operation("cua-artifact", ...args);
  `);
  const officeShim = shim(`
    export const verifyOfficeAfterPack = (...args) => state.operation("office-pack", ...args);
    export const verifyOfficeAfterSign = (...args) => state.operation("office-sign", ...args);
    export const verifyOfficeFinalArtifact = (...args) => state.operation("office-artifact", ...args);
  `);
  const developmentShim = shim("export const verifyMacDevelopmentBundle = (...args) => state.operation('mac-development', ...args);");
  const extractorShim = shim("export const extractCuaDriverFinalArtifact = state.extractor;");
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if ([...wrapperUrls.values()].includes(context.parentURL)) {
      if (specifier === "./hooks.mjs" && !(options.realArtifact && context.parentURL === wrapperUrls.get("artifact-build-completed"))) {
        return { shortCircuit: true, url: hooksShim };
      }
      if (specifier === "../packaged-office-native-package-checks.mjs") {
        return { shortCircuit: true, url: options.realOffice ? checksUrl : officeShim };
      }
      if (specifier === "../macos-development-signing.mjs" && !options.realOffice) {
        return { shortCircuit: true, url: developmentShim };
      }
      if (specifier === "./final-artifact-extractor.mjs") return { shortCircuit: true, url: extractorShim };
    }
    if (context.parentURL === checksUrl) {
      if (specifier === "./build-packaged-office-native.mjs") {
        return { shortCircuit: true, url: shim(`
          export function readActiveOriginalPackagedOfficeNativePublication() {
            state.activeReads++; throw new Error("explicit_test_only_nonmac_must_not_read_office");
          }
        `) };
      }
      if (specifier === "./cua-driver-signing/final-artifact-extractor.mjs") {
        return { shortCircuit: true, url: extractorShim };
      }
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  const api = new Map();
  for (const [role, url] of wrapperUrls) api.set(role, (await import(url)).default);
  return { state, api };
}

function companion(kind, overrides = {}) {
  return { file: `/explicit-test-only/Ling.${kind}.blockmap`, target: { name: kind },
    arch: null, updateInfo: {}, packager: { platform: { nodeName: "darwin" } }, ...overrides };
}

function macContext(role) {
  return role === "artifact-build-completed"
    ? { file: "/explicit-test-only/Ling.zip", target: { name: "zip" }, arch: 0,
        packager: { platform: { nodeName: "darwin" } } }
    : { electronPlatformName: "darwin", explicitTestOnly: role };
}

test("real Office hook wiring (explicit synthetic dependencies, no signing/package acceptance)", async t => {
  for (const kind of ["zip", "dmg"]) await t.test(`real ${kind} companion blockmap keeps original Cua skip without Office`, async t => {
    const f = await fixture(t, { realArtifact: true, forbidOffice: true });
    assert.deepEqual(await f.api.get("artifact-build-completed")(companion(kind)),
      { skipped: true, reason: "companion_blockmap" });
    assert.deepEqual(f.state.audit, []);
  });

  await t.test("original nullish arch contract includes omitted arch, not only explicit null", async t => {
    const f = await fixture(t, { realArtifact: true, forbidOffice: true });
    const context = companion("zip"); delete context.arch;
    assert.deepEqual(await f.api.get("artifact-build-completed")(context),
      { skipped: true, reason: "companion_blockmap" });
    assert.deepEqual(f.state.audit, []);
  });

  for (const [name, overrides] of [
    ["arch zero", { arch: 0 }], ["actual non-null architecture", { arch: "arm64" }],
    ["missing updateInfo", { updateInfo: undefined }], ["null updateInfo", { updateInfo: null }],
    ["actual ZIP artifact", { file: "/explicit-test-only/Ling.zip" }],
    ["actual DMG artifact", { file: "/explicit-test-only/Ling.dmg", target: { name: "dmg" } }],
    ["noncompanion target", { target: { name: "pkg" } }], ["missing target", { target: undefined }],
  ]) await t.test(`${name} must still enter Office before Cua`, async t => {
    const f = await fixture(t), context = companion("zip", overrides);
    assert.equal(await f.api.get("artifact-build-completed")(context), f.state.results["cua-artifact"]);
    assert.deepEqual(f.state.audit, ["office-artifact:enter", "office-artifact:completed", "cua-artifact:enter", "cua-artifact:completed"]);
    assert.equal(f.state.calls[0].context, context);
    assert.equal(f.state.calls[1].callOptions.extractArtifact, f.state.extractor);
  });

  for (const [role, gated, expected] of [
    ["after-pack", "office-pack", ["office-pack:enter", "office-pack:completed", "cua-pack:enter", "cua-pack:completed"]],
    ["after-sign", "office-sign", ["cua-sign:enter", "cua-sign:completed", "mac-development:enter", "mac-development:completed", "office-sign:enter", "office-sign:completed"]],
    ["artifact-build-completed", "office-artifact", ["office-artifact:enter", "office-artifact:completed", "cua-artifact:enter", "cua-artifact:completed"]],
  ]) await t.test(`${role} awaits Office in the intended order and returns original Cua result`, async t => {
    const f = await fixture(t), gate = deferred(), entered = deferred();
    f.state.gates[gated] = gate; f.state.entered[gated] = entered;
    let settled = false;
    const pending = f.api.get(role)(macContext(role)).finally(() => { settled = true; });
    let result;
    try {
      await entered.promise; assert.equal(settled, false);
      assert.equal(f.state.audit.includes(gated + ":completed"), false);
      if (role !== "after-sign") assert.equal(f.state.audit.some(event => event.startsWith("cua-")), false);
    } finally { gate.settle(); result = await pending; }
    assert.deepEqual(f.state.audit, expected);
    assert.equal(result, f.state.results[role === "after-pack" ? "cua-pack" : role === "after-sign" ? "cua-sign" : "cua-artifact"]);
  });

  for (const [role, office, cua] of [
    ["after-pack", "office-pack", "cua-pack"], ["after-sign", "office-sign", "cua-sign"],
    ["artifact-build-completed", "office-artifact", "cua-artifact"],
  ]) {
    await t.test(`${role} propagates Office failure without success or later Cua work`, async t => {
      const f = await fixture(t); f.state.rejectAt = office;
      await assert.rejects(f.api.get(role)(macContext(role)), error => error === f.state.failure);
      assert.equal(f.state.audit.includes(office + ":completed"), false);
      if (role !== "after-sign") assert.equal(f.state.audit.includes(cua + ":enter"), false);
    });
    await t.test(`${role} propagates original Cua failure unchanged`, async t => {
      const f = await fixture(t); f.state.rejectAt = cua;
      await assert.rejects(f.api.get(role)(macContext(role)), error => error === f.state.failure);
      assert.equal(f.state.audit.includes(cua + ":completed"), false);
      if (role === "after-sign") assert.equal(f.state.audit.includes("mac-development:enter"), false);
    });
  }

  await t.test("afterSign preserves Mac development verification before Office and its failure", async t => {
    const f = await fixture(t); f.state.rejectAt = "mac-development";
    await assert.rejects(f.api.get("after-sign")(macContext("after-sign")), error => error === f.state.failure);
    assert.deepEqual(f.state.audit, ["cua-sign:enter", "cua-sign:completed", "mac-development:enter"]);
  });

  await t.test("afterPack retains provider authority and pre-sign digest options", async t => {
    const f = await fixture(t);
    const authority = { schemaVersion: 1, componentId: "cua-driver", distributionRevision: "0.8.3-ling.1",
      providerExpected: true, platform: "win32", signingTier: "test_signed_internal", distributionChannel: "internal",
      capabilitiesSha256: "a".repeat(64), runtimeTrustPolicySha256: "b".repeat(64) };
    process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER = "1";
    process.env.LING_CUA_PACKAGE_HOST_AUTHORITY_JSON = JSON.stringify(authority);
    process.env.LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256 = "c".repeat(64);
    await f.api.get("after-pack")({ electronPlatformName: "win32" });
    assert.deepEqual(f.state.calls.find(call => call.role === "cua-pack").callOptions,
      { requireProvider: true, expectedHostAuthority: authority, expectedPreSignPayloadSha256: "c".repeat(64) });
  });

  for (const [role, expectedRole] of [["after-pack", "cua-pack"], ["after-sign", "cua-sign"],
    ["artifact-build-completed", "cua-artifact"]]) await t.test(`${role} keeps real nonmac Office no-op and original Cua result`, async t => {
    const f = await fixture(t, { realOffice: true });
    const context = role === "artifact-build-completed"
      ? { file: "/explicit-test-only/Ling.exe", target: { name: "nsis" }, arch: 0,
          packager: { platform: { nodeName: "win32" } } }
      : { electronPlatformName: "win32" };
    assert.equal(await f.api.get(role)(context), f.state.results[expectedRole]);
    assert.equal(f.state.activeReads, 0);
    assert.deepEqual(f.state.audit, [expectedRole + ":enter", expectedRole + ":completed"]);
    if (role === "after-pack") assert.deepEqual(f.state.calls[0].callOptions, {});
  });

  t.diagnostic("Real wrappers and the real unchanged nullish-arch companion classifier only. Office/Cua operations are explicit synthetic seams, except real Cua companion skips and real nonmac Office no-ops. No native/source approval, actual extraction, codesign, Electron or package acceptance.");
});
