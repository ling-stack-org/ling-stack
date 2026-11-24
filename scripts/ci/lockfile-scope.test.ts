import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLockfileChange } from "./lockfile-scope.mjs";

function lockfile({ fooVersion = "1.0.0", barVersion = "1.0.0", override = "" } = {}) {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
${override ? `
overrides:
  foo: ${override}
` : ""}
importers:

  apps/alpha:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: ${fooVersion}

  apps/beta:
    dependencies:
      bar:
        specifier: ^1.0.0
        version: ${barVersion}

packages:

  foo@1.0.0: {}
  foo@1.1.0: {}
  bar@1.0.0:
    dependencies:
      foo: ${fooVersion}

snapshots:

  foo@1.0.0: {}
  foo@1.1.0: {}
  bar@1.0.0:
    dependencies:
      foo: ${fooVersion}
`;
}

test("lockfile changes select the importer whose dependency closure changed", () => {
  const result = analyzeLockfileChange({
    before: lockfile(),
    after: lockfile({ fooVersion: "1.1.0" }),
  });
  assert.deepEqual(result, {
    mode: "affected",
    directories: ["apps/alpha", "apps/beta"],
    reason: "verified lockfile dependency closure",
  });
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
