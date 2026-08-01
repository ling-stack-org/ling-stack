import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authProofSigningBytes,
  canonicalJsonBytes,
  canonicalizeJson,
  decodeBase64Url,
  domainSeparatedCanonicalBytes,
  encodeBase64Url,
  fingerprintPublicJwk,
} from "../dist/index.js";

const fixture = JSON.parse(await readFile(
  new URL("../fixtures/v1/canonical-signing.json", import.meta.url),
  "utf8",
));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

test("RFC 8785 canonical JSON matches the shared multilingual fixture", () => {
  assert.equal(canonicalizeJson(fixture.canonical.value), fixture.canonical.text);
  assert.equal(
    encodeBase64Url(canonicalJsonBytes(fixture.canonical.value)),
    fixture.canonical.bytesBase64Url,
  );
});

test("domain-separated auth bytes and ES256 fixture verify exactly", () => {
  const bytes = authProofSigningBytes(fixture.authProof.input);
  assert.equal(encodeBase64Url(bytes), fixture.authProof.signingBytesBase64Url);

  const key = createPublicKey({ key: fixture.deviceIdentity.publicKeyJwk, format: "jwk" });
  assert.equal(verify(
    "sha256",
    bytes,
    { key, dsaEncoding: "ieee-p1363" },
    decodeBase64Url(fixture.authProof.signatureBase64Url),
  ), true);
});

test("canonical public JWK fingerprint matches the shared fixture", async () => {
  assert.equal(
    await fingerprintPublicJwk(fixture.gatewayIdentity.publicKeyJwk, sha256),
    fixture.gatewayIdentity.fingerprint,
  );
  const changed = {
    ...fixture.gatewayIdentity.publicKeyJwk,
    x: `A${fixture.gatewayIdentity.publicKeyJwk.x.slice(1)}`,
  };
  assert.notEqual(await fingerprintPublicJwk(changed, sha256), fixture.gatewayIdentity.fingerprint);
});

test("canonicalization rejects non-I-JSON values", () => {
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalizeJson({ value: undefined }), /undefined/);
  assert.throws(() => canonicalizeJson([, "sparse"]), /sparse/);
  assert.throws(() => canonicalizeJson({ value: "\ud800" }), /surrogate/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeJson(cyclic), /cycles/);
});

test("unpadded base64url is canonical and round-trips every boundary", () => {
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(0, 1),
    Uint8Array.of(0, 1, 2),
    Uint8Array.from({ length: 65 }, (_, index) => index),
  ]) {
    assert.deepEqual(decodeBase64Url(encodeBase64Url(bytes)), bytes);
  }
  assert.throws(() => decodeBase64Url("AA=="), /base64url/);
  assert.throws(() => decodeBase64Url("A"), /base64url/);
});

test("domain separation is unambiguous", () => {
  const left = domainSeparatedCanonicalBytes("ling-left-v1", { a: "bc" });
  const right = domainSeparatedCanonicalBytes("ling-lef", { a: "t-v1\u0000bc" });
  assert.notEqual(encodeBase64Url(left), encodeBase64Url(right));
  assert.equal(left["ling-left-v1".length], 0);
});
