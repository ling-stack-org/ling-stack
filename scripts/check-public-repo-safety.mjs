import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: repositoryRoot, encoding: "utf8" },
).split("\0").filter((file) => file && existsSync(resolve(repositoryRoot, file)));

const allowedUserSegments = new Set([
  "...",
  "alice",
  "example",
  "fixture",
  "me",
  "name",
  "private",
  "test",
  "tester",
  "user",
  "username",
]);
const allowedVolumeSegments = new Set(["External", "example", "fixture", "test"]);
const suspiciousFileNames = /(^|\/)(?:\.env|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|mobileprovision))$/i;
const credentialRules = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["model provider key", /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/g],
];
const allowedCredentialDigests = new Set([
  // Deterministic CUA lease-token golden fixture, not a stored credential.
  "53f9e1b3d5d8062e8ab2f2bbf5edb1018445a0d8e6db1826e3d628b2fdc93dc7",
  // Deterministic second-access sentinel in conversation-media-execution-admission.test.mjs.
  // It must never be read or persisted; keep the exact fixture, not a key-prefix exemption.
  "71fc1755dc1336c6d16c112ac2db3f361dbb1a862a0dee2ce27bd86461af5620",
  // Exact C010 export-redaction sentinel; no general "synthetic" exemption.
  "ed3591aa66597802a38cfd483b640d2f33810e9d95e19f624041b2c1604578b3",
  // Exact B009 command/path redaction sentinels, never Provider credentials.
  "5f5c4fb23677d16af2a8dafd383dbe6148ce399bee78879247f4437537a4017a",
  "bb7f3370c7f539d4bf47e91d41db9531e1334bc3c4db5b1a250758a49fa163ff",
]);
const failures = [];

for (const file of files) {
  if (suspiciousFileNames.test(file) && file !== ".env.example") {
    failures.push(`${file}: sensitive filename`);
    continue;
  }

  const path = resolve(repositoryRoot, file);
  if (statSync(path).size > 5 * 1024 * 1024) continue;
  const content = readFileSync(path);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");

  scanPrivatePaths(file, text);
  scanCredentials(file, text);
  scanPrivateKeyBlocks(file, text);
}

if (failures.length > 0) {
  console.error(`Public repository safety check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Checked ${files.length} repository files; no high-confidence secrets or personal machine paths found.`);

function scanPrivatePaths(file, text) {
  for (const match of text.matchAll(/\/Users\/([^\/\s"'`]+)/g)) {
    if (!allowedUserSegments.has(match[1])) addFailure(file, text, match.index, "personal macOS user path");
  }
  for (const match of text.matchAll(/\/Volumes\/([^\/\s"'`]+)/g)) {
    // Fixed OS-owned locations are not personal mounted volumes. Standalone
    // volumes, lookalikes and private paths below these locations still fail.
    if ((match[1] === "Preboot" || match[1] === "Data")
      && /(?:^|[\s"'`])\/System$/.test(text.slice(0, match.index))) continue;
    if (!allowedVolumeSegments.has(match[1])) addFailure(file, text, match.index, "personal macOS volume path");
  }
  for (const match of text.matchAll(/[A-Za-z]:\\Users\\([^\\\s"'`]+)/g)) {
    if (!allowedUserSegments.has(match[1])) addFailure(file, text, match.index, "personal Windows user path");
  }
  for (const match of text.matchAll(/\/var\/folders\/[A-Za-z0-9_-]+\//g)) {
    addFailure(file, text, match.index, "private macOS temporary path");
  }
}

function scanCredentials(file, text) {
  for (const [label, pattern] of credentialRules) {
    for (const match of text.matchAll(pattern)) {
      if (!clearlyFake(match[0]) && !allowedCredentialFixture(match[0])) {
        addFailure(file, text, match.index, label);
      }
    }
  }
}

function scanPrivateKeyBlocks(file, text) {
  const pattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{80,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  for (const match of text.matchAll(pattern)) {
    addFailure(file, text, match.index, "embedded private key");
  }
}

function clearlyFake(value) {
  return /(?:test|fake|mock|example|placeholder|redacted|outside-workspace|local)/i.test(value);
}

function allowedCredentialFixture(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  return allowedCredentialDigests.has(digest);
}

function addFailure(file, text, index, label) {
  const line = text.slice(0, index ?? 0).split("\n").length;
  failures.push(`${file}:${line}: ${label}`);
}
