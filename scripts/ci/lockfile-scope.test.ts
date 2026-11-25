import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLockfileChange } from "./lockfile-scope.mjs";

function lockfile({
  alphaVersion = "1.0.0",
  barFooVersion = "1.0.0",
  barReference = "1.0.0",
  barMetadata = "    resolution: {integrity: sha512-original}",
  rootImporter = "",
  override = "",
} = {}) {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
${override ? `
overrides:
  foo: ${override}
` : ""}
importers:
${rootImporter}
  apps/alpha:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: ${alphaVersion}

  apps/beta:
    devDependencies:
      bar:
        specifier: ^1.0.0
        version: ${barReference}

packages:

  foo@1.0.0: {}
  foo@1.1.0: {}
  bar@1.0.0:
${barMetadata}

snapshots:

  foo@1.0.0: {}
  foo@1.1.0: {}
  bar@${barReference}:
    dependencies:
      foo: ${barFooVersion}
`;
}

test("lockfile changes select the importer whose dependency closure changed", () => {
  const result = analyzeLockfileChange({
    before: lockfile(),
    after: lockfile({ alphaVersion: "1.1.0", barFooVersion: "1.1.0" }),
  });
  assert.deepEqual(result, {
    mode: "affected",
    directories: ["apps/alpha", "apps/beta"],
    runtimeDirectories: ["apps/alpha"],
    reason: "verified lockfile dependency closure",
  });
});

test("importer-only resolution changes remain scoped when the target node already exists", () => {
  const result = analyzeLockfileChange({ before: lockfile(), after: lockfile({ alphaVersion: "1.1.0" }) });
  assert.deepEqual(result, {
    mode: "affected",
    directories: ["apps/alpha"],
    runtimeDirectories: ["apps/alpha"],
    reason: "verified lockfile dependency closure",
  });
});

test("changes to package metadata include consumers of peer-specific snapshots", () => {
  const barReference = "1.0.0(foo@1.0.0)";
  const result = analyzeLockfileChange({
    before: lockfile({ barReference }),
    after: lockfile({ barReference, barMetadata: "    resolution: {integrity: sha512-updated}" }),
  });
  assert.equal(result.mode, "affected");
  assert.deepEqual(result.directories, ["apps/beta"]);
  assert.deepEqual(result.runtimeDirectories, []);
});

test("a changed transitive dependency of the root importer retains full CI", () => {
  const rootImporter = `
  .:
    devDependencies:
      bar:
        specifier: ^1.0.0
        version: 1.0.0
`;
  const result = analyzeLockfileChange({
    before: lockfile({ rootImporter }),
    after: lockfile({ rootImporter, barFooVersion: "1.1.0" }),
  });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /root lockfile/u);
});

test("a resolution to an absent snapshot retains full CI", () => {
  const result = analyzeLockfileChange({ before: lockfile(), after: lockfile({ alphaVersion: "1.2.0" }) });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /shape could not be verified/u);
});

test("lockfile policy metadata changes retain the full fallback", () => {
  const result = analyzeLockfileChange({
    before: lockfile(),
    after: lockfile({ override: "1.1.0" }),
  });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /metadata changed/u);
});

test("unreachable lockfile records retain the full fallback", () => {
  const before = lockfile();
  const after = before.replace("  foo@1.0.0: {}", "  foo@1.0.0: {}\n  unused@1.0.0: {}");
  const result = analyzeLockfileChange({ before, after });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /unreachable/u);
});
