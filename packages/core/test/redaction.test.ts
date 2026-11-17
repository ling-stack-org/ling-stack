import assert from "node:assert/strict";
import test from "node:test";
import { redactGitRemoteUrl, redactSecrets } from "../dist/index.js";

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

test("Git remote fields are redacted as checkout hints", () => {
  assert.deepEqual(redactSecrets({
    gitRemoteUrl: "https://user:password@git.example.com/owner/repo.git",
  }), {
    gitRemoteUrl: "https://***@git.example.com/owner/repo.git",
  });
  assert.deepEqual(redactSecrets({
    nested: [{ git_remote_url: "https://git.example.com/resolved-fixture-secret.git?key=query-fixture" }],
  }, ["resolved-fixture-secret"]), {
    nested: [{ git_remote_url: "https://git.example.com/[REDACTED].git?key=***" }],
  });
});

test("Git remote redaction masks userinfo and all credential query parameters while retaining SSH hints", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["https://token-fixture@git.example.com/owner/repo.git", "https://***@git.example.com/owner/repo.git"],
    ["ssh://git:password-fixture@git.example.com/owner/repo.git", "ssh://***@git.example.com/owner/repo.git"],
    ["git@git.example.com:owner/repo.git", "git@git.example.com:owner/repo.git"],
    ["ssh://git@git.example.com/owner/repo.git", "ssh://git@git.example.com/owner/repo.git"],
    ["https://user:password-fixture@git.example.com/repo.git?token=one&token=two&key=three&ref=main",
      "https://***@git.example.com/repo.git?token=***&key=***&ref=main"],
    ["https://git.example.com/repo.git?TOKEN=one&access_token=two&private_token=three&auth=four&key=five",
      "https://git.example.com/repo.git?TOKEN=***&access_token=***&private_token=***&auth=***&key=***"],
    ["https://git.example.com/repo.git?%74oken=encoded-fixture", "https://git.example.com/repo.git?token=***"],
  ];
  for (const [input, expected] of cases) assert.equal(redactGitRemoteUrl(input), expected);
});

test("repeated and alternating redaction calls do not retain global regex state", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["Bearer fake-first and Basic fake-second and sk-fakecombined123456", "[REDACTED] and [REDACTED] and [REDACTED]"],
    ["sk-fakeonly123456", "[REDACTED]"],
    ["Basic fake-only", "[REDACTED]"],
    ["ordinary result", "ordinary result"],
  ];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected);
  }
});
