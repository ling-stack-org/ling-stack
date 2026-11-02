import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

let fixtureId = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Actual authored hook, synthetic Office/CUA boundaries. No real archives,
// signing, native build, filesystem deletion, or approval record changes.
async function fixture(t) {
  const id = ++fixtureId;
  const symbolName = `ling.artifact-hook.synthetic.${id}`;
  const symbol = Symbol.for(symbolName);
  const state = {
    async office() {},
    async cua(context) { return context.file; },
    async extract() { throw new Error("synthetic_extraction_not_expected"); },
  };
  globalThis[symbol] = state;
  t.after(() => { delete globalThis[symbol]; });
  const url = new URL(`../scripts/cua-driver-signing/artifact-build-completed.mjs?synthetic=${id}`, import.meta.url).href;
  const bridge = `const state = globalThis[Symbol.for(${JSON.stringify(symbolName)})];\n`;
  const sources = new Map([
    ["./hooks.mjs", bridge + "export function isCompanionBlockmap(c) { return c.file.endsWith('.blockmap'); } export function runArtifactBuildCompleted(...args) { return state.cua(...args); }"],
    ["./final-artifact-extractor.mjs", bridge + "export function extractCuaDriverFinalArtifact(...args) { return state.extract(...args); }"],
    ["../packaged-office-native-package-checks.mjs", bridge + "export function verifyOfficeFinalArtifact(...args) { return state.office(...args); }"],
  ]);
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === url && sources.has(specifier)) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(sources.get(specifier)) };
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  return { state, hook: (await import(url)).default };
}

test("eight simultaneous artifacts wait for both Office and CUA cleanup before the next extraction", async t => {
  const { state, hook } = await fixture(t);
  const packager = {};
  const office = Array.from({ length: 8 }, deferred);
  const cua = Array.from({ length: 8 }, deferred);
  const calls = [];
  let active = 0, maximumActive = 0;
  state.office = async context => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    calls.push(`office:${context.index}`);
    await office[context.index].promise;
    calls.push(`office-cleaned:${context.index}`);
  };
  state.cua = async (context, options) => {
    assert.equal(typeof options.extractArtifact, "function");
    calls.push(`cua:${context.index}`);
    await cua[context.index].promise;
    calls.push(`cua-cleaned:${context.index}`);
    active--;
    return context.file;
  };
  const results = Array.from({ length: 8 }, (_, index) => hook({ packager, index, file: `${index}.${index % 2 ? "dmg" : "zip"}` }));
  try {
    await nextTurn();
    assert.deepEqual(calls, ["office:0"], "a second container must not be extracted while the first Office verification is live");
    for (let index = 0; index < 8; index++) {
      office[index].resolve();
      await nextTurn();
      assert.equal(calls.at(-1), `cua:${index}`, "Office completion alone must not release the artifact lane");
      assert.equal(calls.filter(value => value.startsWith("office:")).length, index + 1);
      cua[index].resolve();
      assert.equal(await results[index], `${index}.${index % 2 ? "dmg" : "zip"}`);
      await nextTurn();
    }
    assert.equal(active, 0);
    assert.equal(maximumActive, 1);
  } finally {
    for (const gate of [...office, ...cua]) gate.resolve();
    await Promise.allSettled(results);
  }
});

test("verification or awaited cleanup failure prevents queued and later artifacts, without poisoning another Packager", async t => {
  for (const phase of ["office-verification", "office-cleanup", "cua-verification", "cua-cleanup"]) {
    await t.test(phase, async t => {
      const { state, hook } = await fixture(t);
      const packager = {}, otherPackager = {};
      const error = new Error(`injected_${phase}`);
      const calls = [];
      state.office = async context => {
        calls.push(`office:${context.file}`);
        if (context.packager === packager && phase.startsWith("office")) {
          if (phase.endsWith("cleanup")) await nextTurn();
          throw error;
        }
      };
      state.cua = async context => {
        calls.push(`cua:${context.file}`);
        if (context.packager === packager && phase.startsWith("cua")) {
          if (phase.endsWith("cleanup")) await nextTurn();
          throw error;
        }
        return context.file;
      };
      const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => hook({ packager, file: `${index}.zip` })));
      assert.ok(settled.every(result => result.status === "rejected" && result.reason === error));
      assert.deepEqual(calls, phase.startsWith("office") ? ["office:0.zip"] : ["office:0.zip", "cua:0.zip"]);
      await assert.rejects(hook({ packager, file: "later.dmg" }), cause => cause === error);
      assert.equal(await hook({ packager: otherPackager, file: "independent.zip" }), "independent.zip");
    });
  }
});

test("another Packager can verify while the first is waiting, and metadata-only blockmap skip stays intact", async t => {
  const { state, hook } = await fixture(t);
  const packager = {}, otherPackager = {}, gate = deferred();
  const calls = [];
  state.office = async context => {
    calls.push(context.file);
    if (context.packager === packager) await gate.promise;
  };
  const pending = hook({ packager, file: "pending.zip" });
  try {
    await nextTurn();
    assert.equal(await hook({ packager: otherPackager, file: "other.dmg" }), "other.dmg");
    assert.equal(await hook({ packager: otherPackager, file: "other.dmg.blockmap" }), "other.dmg.blockmap");
    assert.deepEqual(calls, ["pending.zip", "other.dmg"]);
  } finally {
    gate.resolve();
    await pending;
  }
});

test("missing or invalid Packager identity cannot bypass the shared verification lane", async t => {
  const { state, hook } = await fixture(t);
  let calls = 0;
  state.office = async () => { calls++; };
  state.cua = async () => { calls++; };
  for (const packager of [undefined, null, false, "shared", 1]) {
    await assert.rejects(hook({ packager, file: "unowned.zip" }), /artifact_verification_packager_required/u);
  }
  assert.equal(calls, 0);
});
