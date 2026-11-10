import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../dist/runtime/sandbox/packaged-office-native-bootstrap.js", import.meta.url);
let sequence = 0;
const encoded = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#office-bootstrap-${++sequence}`;

/** Test-only fixed module rewrites, not real codesign/source/runtime approval. */
async function fixture(options = {}) {
  const audit = [];
  const review = Object.freeze({ finalBinarySha256: "a".repeat(64), sourceSha256: Object.freeze({ "test-only": "b".repeat(64) }) });
  const resources = Object.freeze({ appRoot: "/test-only/Fixture.app", binaryPath: "/test-only/Fixture.app/office-local.node",
    sourceRoot: "/test-only/source", review });
  const marker = `__officeBootstrapTestOnly${++sequence}`;
  Object.defineProperty(globalThis, marker, { configurable: true, value: { options, resources, audit } });
  const resourcesSource = `
    const testOnly = globalThis[${JSON.stringify(marker)}]; let reads = 0;
    export function resolveOriginalPackagedOfficeResources() {
      testOnly.audit.push("resources"); reads++;
      if (testOnly.options.noPublication) return undefined;
      if (reads > 1 && testOnly.options.changedResources) return {...testOnly.resources, binaryPath:"/changed"};
      return testOnly.resources;
    }
  `;
  const signingSource = `
    const testOnly = globalThis[${JSON.stringify(marker)}]; const source = Object.freeze({}); const record = Object.freeze({});
    export function prepareOriginalPackagedCodesignSource() { testOnly.audit.push("prepare"); return source; }
    export function readOriginalPackagedCodesignSource(actual) {
      if (actual !== source) throw Error("test_only_foreign_source");
      return {appBundlePath:testOnly.options.foreignApp?"/foreign.app":testOnly.resources.appRoot};
    }
    export function createOriginalPackagedCodesignInvocation(actual) {
      if (actual !== source) throw Error("test_only_foreign_source"); testOnly.audit.push("invocation"); return record;
    }
    export function readOriginalPackagedCodesignActorEntry() {
      return {invoke(actor,actual) {
        if (actor !== undefined || actual !== record) throw Error("test_only_foreign_invocation");
        testOnly.audit.push("invoke"); return testOnly.options.result ?? {status:0};
      }};
    }
    export const PACKAGED_CODESIGN_ACTOR_ENTRY = readOriginalPackagedCodesignActorEntry();
    export function closeOriginalPackagedCodesignIdentity(actual) {
      if (actual !== source) throw Error("test_only_foreign_source"); testOnly.audit.push("close");
      if (testOnly.options.closeFailure) throw Error("test_only_close_failure");
    }
  `;
  const signingUrl = encoded(signingSource);
  const source = readFileSync(moduleUrl, "utf8")
    .replace('"./packaged-office-native-resources.js"', JSON.stringify(encoded(resourcesSource)))
    .replace('"./packaged-restricted-command-bootstrap.js"', JSON.stringify(signingUrl))
    .replace('"./packaged-codesign-host-source.js"', JSON.stringify(signingUrl));
  assert.ok(!source.includes('from "./'));
  const api = await import(encoded(source));
  return { api, audit, resources, cleanup() { delete globalThis[marker]; } };
}

test("ordinary dev Office bootstrap stays absent without caller/env selection", async () => {
  const api = await import(moduleUrl.href);
  assert.deepEqual(Object.keys(api), ["readPackagedOfficeLocalNativeArtifact"]);
  assert.equal(api.readPackagedOfficeLocalNativeArtifact({ binaryPath: "/caller.node", verifyBundle() { throw Error("caller"); } }), undefined);
});

test("synthetic bootstrap binds same app/signing actor and returns only three immutable selection fields", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const result = f.api.readPackagedOfficeLocalNativeArtifact();
  assert.deepEqual(Object.keys(result).sort(), ["binaryPath", "reviewedBinarySha256", "reviewedSourceSha256"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.reviewedSourceSha256, f.resources.review.sourceSha256);
  assert.deepEqual(f.audit, ["resources", "prepare", "invocation", "invoke", "resources", "close"]);
  t.diagnostic("Test-only resource/actor rewrites; not real signatures, original source certificates, runtime/CLI or packaged success.");
});

for (const [name, options, expected] of [
  ["no publication", { noPublication: true }, undefined],
  ["foreign app", { foreignApp: true }, /bundle_identity_invalid/u],
  ["verification exit failure", { result: { status: 1 } }, /bundle_identity_invalid/u],
  ["verification signal", { result: { status: 0, signal: "SIGTERM" } }, /bundle_identity_invalid/u],
  ["verification spawn error", { result: { status: 0, error: Error("test-only") } }, /bundle_identity_invalid/u],
  ["changed resources after verify", { changedResources: true }, /resources_changed/u],
  ["successful verify with unknown close", { closeFailure: true }, /test_only_close_failure/u],
]) test(`synthetic bootstrap rejects ${name} without a selection result`, async t => {
  const f = await fixture(options); t.after(f.cleanup);
  if (expected) { assert.throws(() => f.api.readPackagedOfficeLocalNativeArtifact(), expected); assert.equal(f.audit.at(-1), "close"); }
  else { assert.equal(f.api.readPackagedOfficeLocalNativeArtifact(), undefined); assert.deepEqual(f.audit, ["resources"]); }
});

test("synthetic verify plus close failure retains both errors", async t => {
  const f = await fixture({ result: { status: 1 }, closeFailure: true }); t.after(f.cleanup);
  assert.throws(() => f.api.readPackagedOfficeLocalNativeArtifact(), error => error instanceof AggregateError
    && /identity_close_unknown/u.test(error.message) && error.errors.length === 2
    && /bundle_identity_invalid/u.test(error.errors[0].message) && /test_only_close_failure/u.test(error.errors[1].message));
});
