import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompositeSecretResolver,
  createEnvSecretResolver,
  isSupportedSecretRef,
  parseSecretRef,
  redactSecrets,
} from "../dist/index.js";

test("secret refs parse env and keychain schemes", () => {
  assert.deepEqual(parseSecretRef("env:OPENAI_API_KEY"), {
    raw: "env:OPENAI_API_KEY",
    kind: "env",
    name: "OPENAI_API_KEY",
  });
  assert.deepEqual(parseSecretRef("keychain:provider_local"), {
    raw: "keychain:provider_local",
    kind: "keychain",
    name: "provider_local",
  });
});

test("secret refs reject malformed values and raw keys", () => {
  for (const ref of ["", "env:", "keychain:", "sk-test_123456789", "file:secret", "env:BAD NAME"]) {
    assert.equal(isSupportedSecretRef(ref), false, ref);
    assert.throws(() => parseSecretRef(ref));
  }
});

test("env resolver reports configured and missing without exposing value in status", () => {
  const resolver = createEnvSecretResolver({ LING_STACK_TEST_KEY: "secret-value" });

  assert.deepEqual(resolver.status("env:LING_STACK_TEST_KEY"), {
    ref: "env:LING_STACK_TEST_KEY",
    kind: "env",
    configured: true,
    errorCode: undefined,
    message: undefined,
  });
  assert.equal("value" in resolver.status("env:LING_STACK_TEST_KEY"), false);
  assert.equal(resolver.resolve("env:LING_STACK_TEST_KEY").value, "secret-value");

  const missing = resolver.status("env:MISSING_KEY");
  assert.equal(missing.configured, false);
  assert.equal(missing.errorCode, "secret_missing");
});

test("composite resolver reports unavailable keychain by default", () => {
  const resolver = createCompositeSecretResolver({ env: {} });
  const status = resolver.status("keychain:provider_local", "provider_api_key");

  assert.equal(status.configured, false);
  assert.equal(status.kind, "keychain");
  assert.equal(status.errorCode, "secret_store_unavailable");
  assert.equal(resolver.resolve("keychain:provider_local").value, undefined);
});

test("redaction can include resolved secret values", () => {
  const redacted = redactSecrets(
    {
      message: "Authorization: Bearer abc and plain injected-secret",
      nested: ["injected-secret"],
    },
    ["injected-secret"],
  );

  assert.deepEqual(redacted, {
    message: "Authorization: [REDACTED] and plain [REDACTED]",
    nested: ["[REDACTED]"],
  });
});
