import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-ui2-p9ef-evidence.mjs");
const scenarioIds = [
  "p9ef-conversation-beta-clean-after-late-alpha",
  "p9ef-conversation-alpha-failure-restored",
  "p9ef-conversation-new-draft-clean-after-stale-upload",
  "p9ef-teammate-designer-clean-after-late-engineer",
  "p9ef-teammate-engineer-error-after-designer-success",
  "p9ef-plugin-row-failure-after-unrelated-success",
  "p9ef-shell-settings-error-restored",
  "p9ef-channel-teammate-add-failure-restored",
];
const surfaceMatrix = [
  [1440, 960, "ling-light", "no-preference"],
  [1440, 960, "ling-light", "no-preference"],
  [1280, 800, "ling-dark", "reduce"],
  [1280, 800, "ling-dark", "reduce"],
  [1440, 960, "ling-light", "no-preference"],
  [1440, 960, "ling-light", "no-preference"],
  [1280, 800, "ling-dark", "reduce"],
  [1280, 800, "ling-light", "reduce"],
];
const failureMatrix = [
  ["POST", "^/conversations/stream(?:\\?.*)?$", "/conversations/stream"],
  ["POST", "^/conversations/stream(?:\\?.*)?$", "/conversations/stream"],
  null,
  null,
  ["PATCH", "^/teammates/teammate_engineer(?:\\?.*)?$", "/teammates/teammate_engineer"],
  ["POST", "^/plugins/(?:built-in%3A|built-in:)owner-a/check(?:\\?.*)?$", "/plugins/built-in%3Aowner-a/check"],
  ["PATCH", "^/workspace-settings(?:\\?.*)?$", "/workspace-settings"],
  ["PUT", "^/teammates/teammate_designer/channels(?:\\?.*)?$", "/teammates/teammate_designer/channels"],
];
const captureCommand = "LING_CAPTURE_UI2_P9EF_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4284 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-p9ef-final-evidence.spec.ts --workers=1";
const source = {
  commit: "a".repeat(40),
  branch: "codex/ui2-p9ef-evidence-fixture",
  dirty: false,
  worktreeStatusSha256: createHash("sha256").update("").digest("hex"),
  identifier: "a".repeat(40),
};

test("accepts the canonical eight-scenario evidence ledger", async (t) => {
  const fixture = await createFixture(t);
  const result = runVerifier(fixture.directory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scenarios=8\/8/u);
});

test("rejects orphan files and canonical scenario count drift", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.directory, "orphan.png"), pngBytes(10, 10));
  fixture.manifest.scenarios.pop();
  await writeManifest(fixture);
  const result = runVerifier(fixture.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly 8 records/u);
  assert.match(result.stderr, /orphan evidence file: orphan\.png/u);
});

test("rejects PNG hash mismatch and sidecar drift", async (t) => {
  const fixture = await createFixture(t);
  const record = fixture.manifest.scenarios[0];
  record.png.sha256 = "f".repeat(64);
  await writeManifest(fixture);
  const result = runVerifier(fixture.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /png\.sha256 does not match/u);
  assert.match(result.stderr, /does not match sidecar/u);
});

test("rejects unexpected runtime errors and overflow above one pixel", async (t) => {
  const fixture = await createFixture(t);
  const record = fixture.manifest.scenarios[2];
  record.runtime.pageErrors.push("synthetic page failure");
  record.runtime.unexpectedConsoleErrors.push({ text: "unexpected console failure", locationUrl: "" });
  record.runtime.overflow.document = 2;
  record.runtime.overflow.owners[0].overflow = 1.5;
  await writeScenarioAndManifest(fixture, record);
  const result = runVerifier(fixture.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pageErrors must be empty/u);
  assert.match(result.stderr, /unexpectedConsoleErrors must be empty/u);
  assert.match(result.stderr, /document exceeds the 1px tolerance/u);
  assert.match(result.stderr, /owners\[0\]\.overflow exceeds the 1px tolerance/u);
});

test("rejects canonical surface drift and a dirty source", async (t) => {
  const fixture = await createFixture(t);
  const record = fixture.manifest.scenarios[7];
  record.theme = "ling-dark";
  record.source.dirty = true;
  fixture.manifest.source.dirty = true;
  await writeScenarioAndManifest(fixture, record);
  for (const other of fixture.manifest.scenarios.slice(0, 7)) {
    other.source.dirty = true;
    await writeJson(path.join(fixture.directory, other.sidecarFile), other);
  }
  await writeManifest(fixture);
  const result = runVerifier(fixture.directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /theme must be "ling-light"/u);
  assert.match(result.stderr, /manifest\.source\.dirty must be false/u);
});

async function createFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ling-p9ef-verifier-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scenarios = [];
  for (let index = 0; index < scenarioIds.length; index += 1) {
    const stableId = scenarioIds[index];
    const [width, height, theme, reducedMotion] = surfaceMatrix[index];
    const expectedFailure = failureMatrix[index];
    const expectedHttpFailures = expectedFailure
      ? [{ method: expectedFailure[0], status: 503, urlPattern: expectedFailure[1], count: 1 }]
      : [];
    const consoleErrors = expectedFailure
      ? [{ text: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", locationUrl: `http://127.0.0.1:4284${expectedFailure[2]}` }]
      : [];
    const httpFailures = expectedFailure
      ? [{ method: expectedFailure[0], status: 503, url: expectedFailure[2] }]
      : [];
    const png = pngBytes(width, height);
    const record = {
      stableId,
      label: `Fixture ${index + 1}`,
      functionIds: [`P9EF-FIXTURE-${String(index + 1).padStart(3, "0")}`],
      fixture: `fixture-${index + 1}`,
      trigger: { summary: `Trigger ${index + 1}`, steps: ["Open surface", "Reach changed state"] },
      owner: { surface: `surface-${index + 1}`, scope: `scope-${index + 1}`, key: `key-${index + 1}` },
      assertions: { visible: ["Owned state is visible"], absent: ["Unrelated state is absent"] },
      expectedHttpFailures,
      overflowOwners: [{ label: "Owned surface", selector: `[data-fixture='${index + 1}']` }],
      viewport: { width, height },
      theme,
      locale: "en-US",
      keyboard: { exercised: true, checks: ["Primary action accepts focus"] },
      reducedMotion,
      status: "captured",
      url: `http://127.0.0.1:4284/fixture/${index + 1}`,
      runtime: {
        consoleErrors,
        pageErrors: [],
        httpFailures,
        expectedConsole503Pattern: "^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$",
        expectedConsole503Count: expectedFailure ? 1 : 0,
        unexpectedConsoleErrors: [],
        unexpectedHttpFailures: [],
        overflow: {
          document: 0,
          body: 0,
          owners: [{
            label: "Owned surface",
            selector: `[data-fixture='${index + 1}']`,
            found: true,
            overflow: 0,
            clientWidth: width,
            scrollWidth: width,
          }],
        },
      },
      png: { file: `${stableId}.png`, width, height, sha256: createHash("sha256").update(png).digest("hex") },
      sidecarFile: `${stableId}.json`,
      servedArtifact: "Vite source via Playwright webServer",
      captureCommand,
      source: { ...source },
      capturedAt: "2026-07-27T08:00:00.000Z",
    };
    scenarios.push(record);
    await writeFile(path.join(directory, record.png.file), png);
    await writeJson(path.join(directory, record.sidecarFile), record);
  }
  const manifest = {
    schemaVersion: 1,
    batchId: "T13-P.9EF",
    status: "captured",
    expectedScenarioIds: [...scenarioIds],
    servedArtifact: "Vite source via Playwright webServer",
    baseUrl: "http://127.0.0.1:4284",
    captureCommand,
    protectedEvidence: { tag: "ui2-web-p9d-checkpoint-20260727", tagCommit: "b".repeat(40) },
    closeout: {
      focusedGate: "pending-final-ledger",
      finalNonDesktopGate: "pending-final-ledger",
      feedbackGuard: {
        status: "pending-final-ledger",
        expected: "writer=0 compatibility=0 consumer=0 released-contracts=22",
      },
      visualReview: "pending",
      excluded: [
        "Desktop cross-platform release acceptance",
        "Quick Theme Studio D3",
        "First Run new entry",
        "Teammate MCP A/A/A",
        "Skill Source Sync",
        "Council Runtime",
      ],
    },
    generatedAt: "2026-07-27T08:00:00.000Z",
    source: { ...source },
    scenarios,
  };
  const fixture = { directory, manifest };
  await writeManifest(fixture);
  return fixture;
}

async function writeScenarioAndManifest(fixture, record) {
  await writeJson(path.join(fixture.directory, record.sidecarFile), record);
  await writeManifest(fixture);
}

async function writeManifest(fixture) {
  await writeJson(path.join(fixture.directory, "manifest.json"), fixture.manifest);
  await writeFile(path.join(fixture.directory, "metadata.md"), metadataFor(fixture.manifest), "utf8");
}

function metadataFor(manifest) {
  return [
    "# T13-P.9EF Final Error Ownership Evidence",
    "",
    "- Batch: `T13-P.9EF`",
    `- Status: \`${manifest.status}\``,
    `- Capture state: \`${manifest.scenarios.length}-of-8\``,
    "- Structural verifier state: `pending`",
    "- Visual review state: `pending`",
    "- Served artifact: Vite source via Playwright webServer",
    `- Base URL: \`${manifest.baseUrl}\``,
    `- Generated at: \`${manifest.generatedAt}\``,
    `- Source commit: \`${manifest.source.commit}\``,
    `- Source branch: \`${manifest.source.branch}\``,
    `- Source dirty: \`${manifest.source.dirty}\``,
    `- Worktree status SHA-256: \`${manifest.source.worktreeStatusSha256}\``,
    `- Source identifier: \`${manifest.source.identifier}\``,
    `- Protected P9-D tag: \`ui2-web-p9d-checkpoint-20260727\` (\`${manifest.protectedEvidence.tagCommit}\`)`,
    `- Focused gate: \`${manifest.closeout.focusedGate}\``,
    `- Final non-Desktop gate: \`${manifest.closeout.finalNonDesktopGate}\``,
    `- Feedback guard: \`${manifest.closeout.feedbackGuard.status}\` (expected ${manifest.closeout.feedbackGuard.expected})`,
    "",
    "```bash",
    captureCommand,
    "```",
    "",
    `Excluded: ${manifest.closeout.excluded.join(", ")}.`,
    "",
  ].join("\n");
}

function pngBytes(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runVerifier(directory) {
  return spawnSync(process.execPath, [scriptPath, "--fixture-directory", directory], {
    cwd: path.dirname(scriptPath),
    encoding: "utf8",
  });
}
