import assert from "node:assert/strict";
import test from "node:test";

import {
  DARWIN_PROVIDER_ENTITLEMENTS,
  combineDarwinSignIgnore,
  isPackagedDarwinProviderPath,
  parseDarwinCodeSignatureDetails,
  parseDesignatedRequirement,
} from "../scripts/cua-driver-signing/darwin-platform-signer.mjs";
import { canonicalJson, sha256Bytes } from "../scripts/cua-driver-signing/signing-contract.mjs";

test("Darwin signer parses the exact Team ID, identifier, CDHash, and runtime flag", () => {
  const identity = parseDarwinCodeSignatureDetails(`
Executable=/private/tmp/ling-cua-driver
Identifier=com.lingstack.desktop.cua-driver
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=3+7 location=embedded
Authority=Apple Development: Ling Builder (ABCDEFGHIJ)
TeamIdentifier=ABCDEFGHIJ
CDHash=0123456789ABCDEF0123456789ABCDEF01234567
`);
  assert.deepEqual(identity, {
    codeIdentifier: "com.lingstack.desktop.cua-driver",
    teamId: "ABCDEFGHIJ",
    cdhash: "0123456789abcdef0123456789abcdef01234567",
    signerSubject: "Apple Development: Ling Builder (ABCDEFGHIJ)",
    hardenedRuntime: true,
  });
});

test("Darwin signer normalizes one designated requirement and locks entitlements", () => {
  assert.equal(
    parseDesignatedRequirement(
      "designated => identifier \"com.lingstack.desktop.cua-driver\" and anchor apple generic\n",
    ),
    "identifier \"com.lingstack.desktop.cua-driver\" and anchor apple generic",
  );
  assert.equal(
    sha256Bytes(canonicalJson(DARWIN_PROVIDER_ENTITLEMENTS)),
    "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac",
  );
});

test("Darwin signer rejects incomplete or ad-hoc identity output", () => {
  assert.throws(
    () => parseDarwinCodeSignatureDetails(`
Identifier=com.lingstack.desktop.cua-driver
CodeDirectory v=20500 size=123 flags=0x2(adhoc) hashes=3+7 location=embedded
TeamIdentifier=not set
`),
    /darwin_codesign_details_invalid/u,
  );
  assert.throws(
    () => parseDesignatedRequirement("requirements=none\n"),
    /darwin_designated_requirement_missing/u,
  );
});

test("Darwin outer signing excludes absolute and walker-relative provider paths", () => {
  assert.equal(
    isPackagedDarwinProviderPath(
      "/tmp/Ling Stack.app/Contents/Resources/providers/cua-driver/0.8.3-ling.1/darwin/ling-cua-driver",
    ),
    true,
  );
  assert.equal(
    isPackagedDarwinProviderPath(
      "Resources/providers/cua-driver/0.8.3-ling.1/darwin/ling-cua-driver",
    ),
    true,
  );
  assert.equal(
    isPackagedDarwinProviderPath("Contents/MacOS/Ling Stack"),
    false,
  );
});

test("Darwin outer signing exposes one predicate instead of the broken osx-sign array path", () => {
  const ignore = combineDarwinSignIgnore(
    [/existing-helper/u],
    isPackagedDarwinProviderPath,
  );
  assert.equal(typeof ignore, "function");
  assert.equal(ignore("Contents/Frameworks/existing-helper"), true);
  assert.equal(
    ignore("Resources/providers/cua-driver/0.8.3-ling.1/darwin/ling-cua-driver"),
    true,
  );
  assert.equal(ignore("Contents/MacOS/Ling Stack"), false);
});
