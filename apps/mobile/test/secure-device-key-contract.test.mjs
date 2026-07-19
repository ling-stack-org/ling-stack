import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  types: new URL("../src/platform/secure-device-key/types.ts", import.meta.url),
  adapter: new URL("../src/platform/secure-device-key/native-adapter.ts", import.meta.url),
  fixture: new URL("../src/platform/secure-device-key/fixture-runner.ts", import.meta.url),
  manifest: new URL("../package.json", import.meta.url),
  appConfig: new URL("../app.json", import.meta.url),
  ios: new URL("../modules/ling-secure-device-key/ios/SecureEnclaveP256KeyStore.swift", import.meta.url),
  android: new URL("../modules/ling-secure-device-key/android/src/main/java/expo/modules/lingsecuredevicekey/AndroidKeystoreP256KeyStore.kt", import.meta.url),
};

test("JavaScript/native contract never exposes a private-key export operation", async () => {
  const types = await readFile(files.types, "utf8");
  assert.doesNotMatch(types, /exportPrivateKey|privateKeyBytes|privateJwk/);
  assert.match(types, /privateKeyExportable: false/);
});

test("iOS adapter requires Secure Enclave and checks private-key non-exportability", async () => {
  const source = await readFile(files.ios, "utf8");
  assert.match(source, /kSecAttrTokenIDSecureEnclave/);
  assert.match(source, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
  assert.match(source, /SecKeyCopyExternalRepresentation\(privateKey/);
  assert.match(source, /privateKeyExportable/);
  assert.doesNotMatch(source, /softwareFallback|bearerToken/);
});

test("Android adapter uses AndroidKeyStore and checks encoded private key is null", async () => {
  const source = await readFile(files.android, "utf8");
  assert.match(source, /AndroidKeyStore/);
  assert.match(source, /ECGenParameterSpec\(CURVE_NAME\)/);
  assert.match(source, /privateKey\.encoded == null/);
  assert.match(source, /keyInfo\.securityLevel/);
  assert.doesNotMatch(source, /bearerToken/);
});

test("native DER signatures are converted to the fixed protocol wire encoding", async () => {
  const source = await readFile(files.adapter, "utf8");
  assert.match(source, /es256DerToP1363/);
  assert.match(source, /es256P1363ToDer/);
  assert.match(source, /x962_der/);
});

test("real-device fixture covers pinning, fixed signatures and key lifecycle", async () => {
  const source = await readFile(files.fixture, "utf8");
  assert.match(source, /matchesPublicJwkFingerprint/);
  assert.match(source, /fixed_signature_verification_failed/);
  assert.match(source, /pairingChallengeSigningBytes/);
  assert.match(source, /pairingProofSigningBytes/);
  assert.match(source, /pairingAcceptedSigningBytes/);
  assert.match(source, /hmacSha256/);
  assert.match(source, /allSigningFixturesVerified/);
  assert.match(source, /secure_key_reload_changed_public_key/);
  assert.match(source, /deleted_secure_key_still_signed/);
  assert.match(source, /secure_key_regeneration_did_not_rotate_identity/);
  assert.match(source, /nodeInteropEvidence/);
});

test("Mobile scripts build workspace dependencies and target native platforms only", async () => {
  const manifest = JSON.parse(await readFile(files.manifest, "utf8"));
  const appConfig = JSON.parse(await readFile(files.appConfig, "utf8"));
  assert.match(manifest.scripts["build:deps"], /remote-protocol build/);
  assert.equal(manifest.scripts.prestart, "corepack pnpm run build:deps");
  assert.equal(manifest.scripts.preios, "corepack pnpm run build:deps");
  assert.equal(manifest.scripts.preandroid, "corepack pnpm run build:deps");
  assert.deepEqual(appConfig.expo.platforms, ["ios", "android"]);
  assert.equal(manifest.dependencies["react-dom"], undefined);
});

test("Mobile spike has no Web or DOM UI dependency", async () => {
  for (const file of [files.types, files.adapter, files.fixture]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /apps\/web|conversation-ui-react|react-dom|\bHTMLElement\b|\bdocument\./);
  }
});
