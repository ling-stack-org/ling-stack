import assert from "node:assert/strict";
import test from "node:test";
import { redactGitRemoteUrl, redactSecrets } from "../dist/index.js";

function fixtureBasicAuthUrl(host: string, path: string, user = "user", password = "password"): string {
  return `https://${[user, password].join(":")}@${host}/${path}`;
}

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
    gitRemoteUrl: fixtureBasicAuthUrl("git.example.com", "owner/repo.git"),
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
    [`${fixtureBasicAuthUrl("git.example.com", "repo.git", "user", "password-fixture")}?token=one&token=two&key=three&ref=main`,
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

test("cloud, repository and JWT credential formats are redacted from strings", () => {
  const input = [
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    ["github=", ["ghp_", "123456789012345678901234567890123456"].join("")].join(""),
    ["slack=", ["xoxb-", "1234567890-1234567890-abcdefghijklmnop"].join("")].join(""),
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value",
  ].join("\n");
  assert.equal(redactSecrets(input), [
    "AWS_ACCESS_KEY_ID=[REDACTED]",
    "github=[REDACTED]",
    "slack=[REDACTED]",
    "jwt=[REDACTED]",
  ].join("\n"));
});

test("assignment redaction covers provider credentials and escaped quoted values", () => {
  const databaseUrl = `postgres://alice:${["db", "password"].join("-")}@example.test/app`;
  const input = [
    'AWS_SECRET_ACCESS_KEY="secret-access-value"',
    'AWS_SESSION_TOKEN=secret-session-value',
    `DATABASE_URL="${databaseUrl}"`,
    'const password = "prefix\\\"SECRET-SUFFIX"; console.log("safe");',
  ].join("\n");
  const redacted = redactSecrets(input);
  assert.equal(redacted, [
    'AWS_SECRET_ACCESS_KEY="[REDACTED]"',
    'AWS_SESSION_TOKEN=[REDACTED]',
    'DATABASE_URL="[REDACTED]"',
    'const password = "[REDACTED]"; console.log("safe");',
  ].join("\n"));
});

test("object-valued authority fields in serialized context remain intact", () => {
  const input = '{"policyAuthority":{"kind":"channel_effective_policy_v1","workspaceId":"workspace_default"}}';
  assert.equal(redactSecrets(input), input);
});

test("authorization modes remain usable while authorization credentials are redacted", () => {
  assert.deepEqual(redactSecrets({
    authorization: "Bearer secret-token",
    authorizationHeader: "Bearer header-secret",
    authorizationMode: "always",
    defaultAuthorizationMode: "smart",
  }), {
    authorization: "[REDACTED]",
    authorizationHeader: "[REDACTED]",
    authorizationMode: "always",
    defaultAuthorizationMode: "smart",
  });
});

test("token-count prose remains intact while singular token assignments are redacted", () => {
  assert.equal(redactSecrets("Estimated input tokens: 420/31232\nTotal tokens: 436"),
    "Estimated input tokens: 420/31232\nTotal tokens: 436");
  assert.equal(redactSecrets('maxTokens: 16384\ncontextWindowTokens: 32768'),
    'maxTokens: 16384\ncontextWindowTokens: 32768');
  assert.equal(redactSecrets("token: bearer-secret"), "token: [REDACTED]");
  assert.equal(redactSecrets("tokens: bearer-secret"), "tokens: [REDACTED]");
  assert.equal(redactSecrets("maxTokens: bearer-secret"), "maxTokens: [REDACTED]");
  assert.equal(redactSecrets("accessToken: 123"), "accessToken: [REDACTED]");
  assert.equal(redactSecrets("token: 123"), "token: [REDACTED]");
});

test("structured credential metadata remains usable without passing credential values through", () => {
  assert.deepEqual(redactSecrets({
    secretHeaderNames: ["Authorization"],
    configuredSecretNames: ["Authorization"],
    secretStatus: "configured",
    secretRefKind: "env",
    missingSecretCount: 1,
    missingSecretRefs: [],
    maxTokens: 16384,
    nested: { secretHeaderNames: ["Bearer fixture-value"], clientCredential: "fixture-value", webhookSecret: "fixture-value" },
    accessToken: 123,
  }), {
    secretHeaderNames: ["Authorization"],
    configuredSecretNames: ["Authorization"],
    secretStatus: "configured",
    secretRefKind: "env",
    missingSecretCount: 1,
    missingSecretRefs: [],
    maxTokens: 16384,
    nested: { secretHeaderNames: ["[REDACTED]"], clientCredential: "[REDACTED]", webhookSecret: "[REDACTED]" },
    accessToken: "[REDACTED]",
  });
});
