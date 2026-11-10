import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../dist/index.js";

test("mixed authentication and OpenAI-style secrets are all redacted in one pass", () => {
  for (const scheme of ["Bearer", "Basic", "bEaReR", "bAsIc"]) {
    const input = `before sk-fakebefore123456\n${scheme} fake-auth-value\nafter sk-fakeafter123456`;
    assert.equal(redactSecrets(input), "before [REDACTED]\n[REDACTED]\nafter [REDACTED]");
  }
});

test("mixed-pattern redaction preserves resolved-secret replacement and nested key redaction", () => {
  assert.deepEqual(redactSecrets({
    output: "Bearer fake-auth-value and sk-fakeapikey123456 and resolved-fake-secret",
    nested: [{ access_token: "fake-key-value", output: "Basic fake-basic-value and sk-fakenested123456" }],
  }, ["resolved-fake-secret"]), {
    output: "[REDACTED] and [REDACTED] and [REDACTED]",
    nested: [{ access_token: "[REDACTED]", output: "[REDACTED] and [REDACTED]" }],
  });
});

test("repeated and alternating redaction calls do not retain global regex state", () => {
  const cases = [
    ["Bearer fake-first and Basic fake-second and sk-fakecombined123456", "[REDACTED] and [REDACTED] and [REDACTED]"],
    ["sk-fakeonly123456", "[REDACTED]"],
    ["Basic fake-only", "[REDACTED]"],
    ["ordinary result", "ordinary result"],
  ];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected);
  }
});
