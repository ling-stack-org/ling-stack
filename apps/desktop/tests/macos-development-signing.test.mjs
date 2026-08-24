import assert from "node:assert/strict";
import test from "node:test";

import { verifyMacDevelopmentBundle } from "../scripts/macos-development-signing.mjs";

test("unsigned macOS engineering package verifies the complete ad-hoc signed app", async () => {
  const calls = [];
  const result = await verifyMacDevelopmentBundle({
    appOutDir: "/tmp/ling-macos-signing-fixture",
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "Ling Stack" } },
  }, {
    async execFile(command, args) {
      calls.push({ command, args });
    },
    profile: { signingTier: "unsigned_dev" },
  });
  assert.deepEqual(calls, [{
    command: "/usr/bin/codesign",
    args: [
      "--verify",
      "--deep",
      "--strict",
      "/tmp/ling-macos-signing-fixture/Ling Stack.app",
    ],
  }]);
  assert.equal(result.identity, "ad-hoc");
});

test("production signing keeps its existing release verifier", async () => {
  const result = await verifyMacDevelopmentBundle({
    appOutDir: "/tmp/ling-macos-signing-fixture",
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "Ling Stack" } },
  }, {
    async execFile() {
      throw new Error("production verification must not use the development verifier");
    },
    profile: { signingTier: "production_signed" },
  });
  assert.deepEqual(result, { skipped: true, reason: "release_signing_profile" });
});
