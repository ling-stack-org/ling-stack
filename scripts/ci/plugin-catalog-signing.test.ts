import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";
import { requireOfficialSigningKey } from "../plugins/official-signing-key.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const secretName = "LING_PLUGIN_CATALOG_PRIVATE_KEY";

test("the configured private key can sign for the pinned public key", () => {
  const key = requireOfficialSigningKey(privatePem, publicPem, secretName);
  const bytes = Buffer.from("plugin catalog");
  assert.ok(verify(null, bytes, publicKey, sign(null, bytes, key)));
});

test("the signing preflight rejects missing, public-only and mismatched keys", () => {
  const unrelatedPublic = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => requireOfficialSigningKey("", publicPem, secretName), /PRIVATE_KEY is required/u);
  assert.throws(() => requireOfficialSigningKey(publicPem, publicPem, secretName));
  assert.throws(() => requireOfficialSigningKey(privatePem, unrelatedPublic, secretName), /does not match/u);
});
