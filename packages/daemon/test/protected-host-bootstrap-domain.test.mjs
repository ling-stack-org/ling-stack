import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { readProtectedHostBootstrapReadRoots } from "../dist/runtime/sandbox/protected-host-bootstrap-domain.js";
import { readMacosSandboxBackendIdentity } from "../dist/runtime/sandbox/macos-sandbox-backend.js";
import { MACOS_DYLD_PROFILE } from "../dist/runtime/sandbox/macos-seatbelt-profile.js";

const mac27 = "bdfc2354c683c8fb95a39e63fbc8610e9739b0256c89ab880564edefbe73a5ce";
const mac26 = "06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c";

// Selection contract only: hash results are simulated, not OS/kernel evidence.
// The real CI staging suite uses the actual reviewed profile without this seam.
test("bootstrap review is an exact finite digest set and still binds backend identity", {
  skip: process.platform !== "darwin",
}, async t => {
  const originalHash = crypto.createHash;
  const actualSha = originalHash("sha256").update(readFileSync(MACOS_DYLD_PROFILE)).digest("hex");
  const backend = readMacosSandboxBackendIdentity();
  assert.ok(backend.helperVersion.endsWith(":" + actualSha));
  for (const [name, digest, helperDigest, accepted] of [
    ["reviewed macOS 27", mac27, mac27, true],
    ["reviewed actual CI macOS 26", mac26, mac26, true],
    ["unreviewed exact digest", "0".repeat(64), "0".repeat(64), false],
    ["reviewed digest with wrong backend", mac26, "1".repeat(64), false],
  ]) {
    await t.test(name, t => {
      const patch = t.mock.method(crypto, "createHash", (algorithm, ...args) => {
        const hash = originalHash(algorithm, ...args), originalDigest = hash.digest;
        hash.digest = function (encoding) {
          const bytes = Reflect.apply(originalDigest, this, []);
          const result = algorithm === "sha256" && bytes.toString("hex") === actualSha
            ? Buffer.from(digest, "hex") : bytes;
          return encoding ? result.toString(encoding) : result;
        };
        return hash;
      });
      syncBuiltinESMExports();
      t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
      const input = { ...backend, helperVersion: backend.helperVersion.slice(0, -64) + helperDigest };
      if (accepted) assert.deepEqual(readProtectedHostBootstrapReadRoots(input), ["/dev", "/System"]);
      else assert.throws(() => readProtectedHostBootstrapReadRoots(input), /protected_host_bootstrap_domain_unverified/u);
    });
  }
});
