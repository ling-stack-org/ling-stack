import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MACOS_SIGNED_CANDIDATE_LIMITATIONS,
  assertDeveloperIdSignature,
  assertMacosCandidateMatrix,
  assertNotarizedAssessment,
  assertNestedMachOArchitectureCompatibility,
  computeAppBundleTreeSha256,
  candidateReportFingerprint,
  parseCliArguments,
  parseCodesignDetails,
  parseMachOHeader,
  parseSpctlAssessment,
  resolveMacosCandidateArtifactPaths,
  verifyMacosSignedCandidate,
} from "./verify-macos-signed-candidate.mjs";
import {
  MACOS_SYSTEM_TOOLS,
  assertReleaseHarnessProvenance,
  buildReleaseHarnessProvenance,
  captureMacosReleaseHarnessProvenance,
  macosSystemTool,
} from "./macos-acceptance-common.mjs";

const TEAM_ID = "ABCDE12345";
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("parses repeated artifact arguments and validates release identity inputs", () => {
  const parsed = parseCliArguments([
    "--team-id",
    TEAM_ID,
    "--bundle-id=com.lingstack.desktop",
    "--app",
    "First.app",
    "--app=Second.app",
    "--dmg",
    "Ling.dmg",
    "--zip=Ling.zip",
    "--output",
    "report.json",
  ]);
  assert.equal(parsed.teamId, TEAM_ID);
  assert.equal(parsed.bundleId, "com.lingstack.desktop");
  assert.deepEqual(parsed.apps, [resolve("First.app"), resolve("Second.app")]);
  assert.deepEqual(parsed.dmgs, [resolve("Ling.dmg")]);
  assert.deepEqual(parsed.zips, [resolve("Ling.zip")]);
  assert.equal(parsed.output, resolve("report.json"));
});

test("CLI parsing fails closed without a valid Team ID or artifact", () => {
  assert.throws(
    () => parseCliArguments(["--app", "Ling.app"]),
    /--team-id is required/,
  );
  assert.throws(
    () => parseCliArguments(["--team-id", TEAM_ID, "--app", "Ling.app"]),
    /--bundle-id is required/,
  );
  assert.throws(
    () =>
      parseCliArguments([
        "--team-id",
        TEAM_ID,
        "--bundle-id",
        "com.example.other",
        "--app",
        "Ling.app",
      ]),
    /--bundle-id must be com\.lingstack\.desktop/u,
  );
  assert.throws(
    () => parseCliArguments(["--team-id", "lowercase1", "--app", "Ling.app"]),
    /10-character uppercase Apple Team ID/,
  );
  assert.throws(
    () =>
      parseCliArguments([
        "--team-id",
        TEAM_ID,
        "--bundle-id",
        "com.lingstack.desktop",
        "--dmg",
        "Ling.dmg",
      ]),
    /At least one --app/,
  );
  assert.throws(
    () =>
      parseCliArguments([
        "--team-id",
        TEAM_ID,
        "--app",
        "Ling.app",
        "--unknown",
        "x",
      ]),
    /Unknown argument/,
  );
});

test("parses a Developer ID signature with Team ID and hardened runtime", () => {
  const details = parseCodesignDetails(validCodesignOutput());
  assert.equal(details.identifier, "com.lingstack.desktop");
  assert.equal(details.teamIdentifier, TEAM_ID);
  assert.equal(details.hardenedRuntime, true);
  assert.match(details.entitlements, /com\.apple\.security\.cs\.allow-jit/u);
  assert.match(details.entitlementsSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(details.authorities, [
    `Developer ID Application: Ling Stack (${TEAM_ID})`,
    "Developer ID Certification Authority",
    "Apple Root CA",
  ]);
  assert.deepEqual(assertDeveloperIdSignature(details, TEAM_ID, "fixture"), {
    developerAuthority: `Developer ID Application: Ling Stack (${TEAM_ID})`,
    teamIdentifier: TEAM_ID,
    hardenedRuntime: true,
    cdhash: "a".repeat(40),
    cdhashFull: "b".repeat(64),
  });
});

test("signature validation rejects ad-hoc, wrong-Team, and non-runtime code", () => {
  const valid = parseCodesignDetails(validCodesignOutput());
  assert.throws(
    () =>
      assertDeveloperIdSignature(
        { ...valid, authorities: [], signature: "adhoc" },
        TEAM_ID,
        "fixture",
      ),
    /not signed by a Developer ID Application authority/,
  );
  assert.throws(
    () =>
      assertDeveloperIdSignature(
        { ...valid, teamIdentifier: "ZZZZZ99999" },
        TEAM_ID,
        "fixture",
      ),
    /TeamIdentifier mismatch/,
  );
  assert.throws(
    () =>
      assertDeveloperIdSignature(
        { ...valid, hardenedRuntime: false },
        TEAM_ID,
        "fixture",
      ),
    /missing the hardened runtime/,
  );
});

test("Gatekeeper assessment requires accepted Notarized Developer ID", () => {
  const accepted = parseSpctlAssessment(
    [
      "/Applications/Ling Stack.app: accepted",
      "source=Notarized Developer ID",
      `origin=Developer ID Application: Ling Stack (${TEAM_ID})`,
    ].join("\n"),
  );
  assert.deepEqual(assertNotarizedAssessment(accepted, "fixture"), accepted);

  assert.throws(
    () =>
      assertNotarizedAssessment(
        parseSpctlAssessment(
          "fixture: rejected\nsource=Unnotarized Developer ID",
        ),
        "fixture",
      ),
    /not accepted by Gatekeeper/,
  );
  assert.throws(
    () =>
      assertNotarizedAssessment(
        parseSpctlAssessment("fixture: accepted\nsource=Developer ID"),
        "fixture",
      ),
    /Gatekeeper source must be Notarized Developer ID/,
  );
});

test("parses thin and fat Mach-O headers without accepting unrelated files", () => {
  const arm64 = thinMachO({ cpuType: 0x0100000c });
  assert.deepEqual(parseMachOHeader(arm64), {
    kind: "mach-o",
    bits: 64,
    endian: "little",
    fat: false,
    magic: "cffaedfe",
    cpuType: 0x0100000c,
    architecture: "arm64",
  });

  const x64 = thinMachO({ cpuType: 0x01000007 });
  assert.equal(parseMachOHeader(x64)?.architecture, "x86_64");

  const fat = Buffer.alloc(8);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  assert.deepEqual(parseMachOHeader(fat), {
    kind: "fat-mach-o",
    bits: 32,
    endian: "big",
    fat: true,
    magic: "cafebabe",
    architectureCount: 2,
  });
  assert.equal(parseMachOHeader(Buffer.from("not Mach-O")), undefined);
  assert.equal(parseMachOHeader(Buffer.alloc(3)), undefined);
});

test("report limitations explicitly exclude TCC, capture-indicator, and VoiceOver claims", () => {
  assert.deepEqual(MACOS_SIGNED_CANDIDATE_LIMITATIONS, {
    tccEvidence: false,
    captureIndicatorEvidence: false,
    voiceOverEvidence: false,
    statement:
      "This verifier establishes the arm64/x86_64 app, DMG, and ZIP signing, notarization-ticket, Gatekeeper, archive-integrity, and embedded-app binding evidence only. " +
      "It does not inspect or mutate macOS TCC state, observe the operating-system capture indicator, or exercise VoiceOver.",
  });
});

test("macOS acceptance pins every system tool to an absolute path", () => {
  for (const [name, path] of Object.entries(MACOS_SYSTEM_TOOLS)) {
    assert.equal(path.startsWith("/"), true, name);
    assert.equal(macosSystemTool(name), path);
  }
  assert.throws(() => macosSystemTool("codesign-shadow"), /system_tool_unknown/u);
});

test(
  "macOS release harness provenance binds every script to its commit blob",
  { skip: !existsSync(MACOS_SYSTEM_TOOLS.git) },
  async () => {
    const fixture = await createReleaseHarnessFixture();
    try {
      const provenance = await buildReleaseHarnessProvenance(
        fixture.commit,
        fixture.scriptPaths,
        fixture.root,
      );
      assert.deepEqual(
        provenance.files.map((file) => ({
          path: file.path,
          gitBlobObjectId: file.gitBlobObjectId,
        })),
        fixture.repositoryPaths.map((path) => ({
          path,
          gitBlobObjectId: git(fixture.root, [
            "rev-parse",
            "--verify",
            `${fixture.commit}:${path}`,
          ]),
        })),
      );
      const actual = structuredClone(provenance);
      assert.equal(
        assertReleaseHarnessProvenance(
          actual,
          provenance,
          fixture.repositoryPaths,
          "fixture",
        ),
        actual,
      );

      delete actual.files[0].gitBlobObjectId;
      assert.throws(
        () =>
          assertReleaseHarnessProvenance(
            actual,
            provenance,
            fixture.repositoryPaths,
            "fixture",
        ),
        /macos_release_harness_binding_invalid:fixture/u,
      );

      const missingVerifier = structuredClone(provenance);
      missingVerifier.files = missingVerifier.files.filter(
        (file) => file.path !== "scripts/verifier.mjs",
      );
      assert.throws(
        () =>
          assertReleaseHarnessProvenance(
            missingVerifier,
            provenance,
            fixture.repositoryPaths,
            "fixture",
          ),
        /macos_release_harness_binding_invalid:fixture:scripts\/verifier\.mjs/u,
      );

      const mismatched = structuredClone(provenance);
      mismatched.files[0].gitBlobObjectId = "f".repeat(40);
      assert.throws(
        () =>
          assertReleaseHarnessProvenance(
            mismatched,
            provenance,
            fixture.repositoryPaths,
            "fixture",
        ),
        /macos_release_harness_binding_invalid:fixture:scripts\/producer\.mjs/u,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test(
  "modified or assume-unchanged harness bytes cannot bind to a clean commit",
  { skip: !existsSync(MACOS_SYSTEM_TOOLS.git) },
  async () => {
    const fixture = await createReleaseHarnessFixture();
    try {
      await writeFile(fixture.scriptPaths[0], "locally modified harness\n", "utf8");
      await assert.rejects(
        buildReleaseHarnessProvenance(
          fixture.commit,
          fixture.scriptPaths,
          fixture.root,
        ),
        /macos_release_harness_commit_blob_mismatch:scripts\/producer\.mjs/u,
      );

      await writeFile(fixture.scriptPaths[0], fixture.scriptContents[0], "utf8");
      assert.equal(git(fixture.root, ["status", "--porcelain=v1"]), "");
      git(fixture.root, [
        "update-index",
        "--assume-unchanged",
        fixture.repositoryPaths[1],
      ]);
      await writeFile(
        fixture.scriptPaths[1],
        "modified verifier hidden from git status\n",
        "utf8",
      );
      assert.equal(
        git(fixture.root, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
        "",
      );

      const capture =
        process.platform === "darwin"
          ? captureMacosReleaseHarnessProvenance(
              fixture.scriptPaths,
              { repoRoot: fixture.root },
            )
          : buildReleaseHarnessProvenance(
              fixture.commit,
              fixture.scriptPaths,
              fixture.root,
            );
      await assert.rejects(
        capture,
        /macos_release_harness_commit_blob_mismatch:scripts\/verifier\.mjs/u,
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test("nested Mach-O code must cover every app architecture", () => {
  assert.deepEqual(
    assertNestedMachOArchitectureCompatibility(["arm64", "x86_64"], ["x86_64", "arm64"]),
    ["arm64", "x86_64"],
  );
  assert.throws(
    () => assertNestedMachOArchitectureCompatibility(["arm64", "x86_64"], ["arm64"], "nested"),
    /missing app execution architecture.*x86_64/u,
  );
});

test("bundle tree fingerprint is deterministic and changes with nested content", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-macos-bundle-fingerprint-"));
  try {
    await mkdir(join(root, "Contents", "MacOS"), { recursive: true });
    const executable = join(root, "Contents", "MacOS", "Ling Stack");
    await writeFile(executable, "one", "utf8");
    const first = await computeAppBundleTreeSha256(root);
    assert.equal(first, await computeAppBundleTreeSha256(root));
    await writeFile(executable, "two", "utf8");
    assert.notEqual(first, await computeAppBundleTreeSha256(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("signed candidate matrix requires matching arm64 and x86_64 app, DMG, and ZIP artifacts", () => {
  const arm64 = candidate("arm64", "a".repeat(64));
  const x64 = candidate("x86_64", "b".repeat(64));
  assert.deepEqual(
    assertMacosCandidateMatrix({
      apps: [arm64, x64],
      dmgs: [archive("arm.dmg", arm64), archive("x64.dmg", x64)],
      zips: [archive("arm.zip", arm64), archive("x64.zip", x64)],
    }),
    {
      pass: true,
      requiredArchitectures: ["arm64", "x86_64"],
      coverage: {
        apps: ["arm64", "x86_64"],
        dmgs: ["arm64", "x86_64"],
        zips: ["arm64", "x86_64"],
      },
    },
  );
  assert.throws(
    () =>
      assertMacosCandidateMatrix({
        apps: [arm64, x64],
        dmgs: [archive("arm.dmg", arm64)],
        zips: [archive("arm.zip", arm64), archive("x64.zip", x64)],
      }),
    /dmgs release matrix is missing x86_64/u,
  );
  assert.throws(
    () =>
      assertMacosCandidateMatrix({
        apps: [arm64, x64],
        dmgs: [archive("arm.dmg", arm64), archive("x64.dmg", x64)],
        zips: [
          archive("arm.zip", arm64),
          archive("x64.zip", candidate("x86_64", "c".repeat(64))),
        ],
      }),
    /does not match a verified standalone app/u,
  );
  const mismatchedBundle = structuredClone(x64);
  mismatchedBundle.bundleFingerprint.treeSha256 = "9".repeat(64);
  assert.throws(
    () =>
      assertMacosCandidateMatrix({
        apps: [arm64, x64],
        dmgs: [archive("arm.dmg", arm64), archive("x64.dmg", x64)],
        zips: [
          archive("arm.zip", arm64),
          archive("x64.zip", mismatchedBundle),
        ],
      }),
    /does not match a verified standalone app/u,
  );
  const universal = candidate("arm64", "c".repeat(64));
  universal.mainExecutable.architectures = ["arm64", "x86_64"];
  assert.throws(
    () =>
      assertMacosCandidateMatrix({
        apps: [universal],
        dmgs: [archive("universal.dmg", universal)],
        zips: [archive("universal.zip", universal)],
      }),
    /requires a dedicated arm64 artifact/u,
  );
});

test("candidate report rejects summary-only PASS and resolves report-relative artifacts", () => {
  assert.throws(
    () =>
      candidateReportFingerprint({
        schemaVersion: 1,
        kind: "ling-desktop-macos-signed-candidate",
        expected: { teamId: TEAM_ID, bundleId: "com.lingstack.desktop" },
        apps: [],
        dmgs: [],
        zips: [],
        matrix: {
          pass: true,
          coverage: {
            apps: ["arm64", "x86_64"],
            dmgs: ["arm64", "x86_64"],
            zips: ["arm64", "x86_64"],
          },
        },
        verdict: { status: "PASS", pass: true, signedCandidateEvidence: true },
      }),
    /requires app, DMG, and ZIP/u,
  );

  const reportPath = resolve("reports/macos/candidate.json");
  const arm64 = candidate("arm64", "a".repeat(64));
  const x64 = candidate("x86_64", "b".repeat(64));
  arm64.path = "../../release/arm64.app";
  x64.path = "../../release/x64.app";
  const report = {
    schemaVersion: 1,
    kind: "ling-desktop-macos-signed-candidate",
    expected: { teamId: TEAM_ID, bundleId: "com.lingstack.desktop" },
    apps: [arm64, x64],
    dmgs: [archive("../../release/arm64.dmg", arm64), archive("../../release/x64.dmg", x64)],
    zips: [archive("../../release/arm64.zip", arm64), archive("../../release/x64.zip", x64)],
    matrix: {
      pass: true,
      requiredArchitectures: ["arm64", "x86_64"],
      coverage: {
        apps: ["arm64", "x86_64"],
        dmgs: ["arm64", "x86_64"],
        zips: ["arm64", "x86_64"],
      },
    },
    verdict: { status: "PASS", pass: true, signedCandidateEvidence: true },
  };
  candidateReportFingerprint(report);
  const paths = resolveMacosCandidateArtifactPaths(report, reportPath);
  assert.equal(paths.apps[0], resolve("release/arm64.app"));
  assert.equal(paths.zips[1], resolve("release/x64.zip"));
});

const localUnsignedApp = resolve(
  desktopRoot,
  "release/mac-arm64/Ling Stack.app",
);
test(
  "a local unsigned engineering app fails the signed-candidate verifier when present",
  {
    skip: process.platform !== "darwin" || !existsSync(localUnsignedApp),
  },
  async () => {
    const report = await verifyMacosSignedCandidate({
      apps: [localUnsignedApp],
      dmgs: [],
      zips: [],
      teamId: TEAM_ID,
      bundleId: "com.lingstack.desktop",
    });
    assert.equal(report.verdict.pass, false);
    assert.equal(report.verdict.signedCandidateEvidence, false);
    assert.equal(report.apps[0].pass, false);
    assert.match(
      report.apps[0].error.message,
      /codesign|signed|signature|TeamIdentifier/iu,
    );
  },
);

function validCodesignOutput() {
  return [
    "Executable=/Applications/Ling Stack.app/Contents/MacOS/Ling Stack",
    "Identifier=com.lingstack.desktop",
    "Format=app bundle with Mach-O thin (arm64)",
    "CodeDirectory v=20500 size=1324 flags=0x10000(runtime) hashes=31+7 location=embedded",
    "Signature size=9101",
    `Authority=Developer ID Application: Ling Stack (${TEAM_ID})`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    `TeamIdentifier=${TEAM_ID}`,
    "Runtime Version=15.0.0",
    `CDHash=${"a".repeat(40)}`,
    `CDHashFull=${"b".repeat(64)}`,
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>',
  ].join("\n");
}

function thinMachO({ cpuType }) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  return buffer;
}

function candidate(architecture, sha256) {
  return {
    type: "app",
    path: `/candidate/${architecture}.app`,
    pass: true,
    bundleIdentifier: "com.lingstack.desktop",
    mainExecutable: {
      path: "Contents/MacOS/Ling Stack",
      architectures: [architecture],
      sha256,
    },
    mainSignature: {
      teamIdentifier: TEAM_ID,
      hardenedRuntime: true,
      entitlementsSha256: "e".repeat(64),
    },
    bundleFingerprint: {
      treeSha256: "a".repeat(64),
      cdhash: "b".repeat(40),
      cdhashFull: "c".repeat(64),
    },
    gatekeeper: { accepted: true, source: "Notarized Developer ID" },
    stapler: { validated: true },
  };
}

function archive(path, embeddedApp) {
  return {
    type: path.endsWith(".dmg") ? "dmg" : "zip",
    path,
    pass: true,
    sha256: (path.endsWith(".dmg") ? "d" : "f").repeat(64),
    embeddedApp,
    ...(path.endsWith(".dmg")
      ? {
          gatekeeper: { accepted: true, source: "Notarized Developer ID" },
          stapler: { validated: true },
        }
      : {}),
  };
}

async function createReleaseHarnessFixture() {
  const root = await mkdtemp(join(tmpdir(), "ling-macos-release-harness-"));
  const repositoryPaths = ["scripts/producer.mjs", "scripts/verifier.mjs"];
  const scriptPaths = repositoryPaths.map((path) => join(root, path));
  const scriptContents = [
    "export const producer = 1;\n",
    "export const verifier = 2;\n",
  ];
  await mkdir(join(root, "scripts"), { recursive: true });
  for (const [index, path] of scriptPaths.entries()) {
    await writeFile(path, scriptContents[index], "utf8");
  }
  for (const args of [
    ["init"],
    ["config", "user.name", "Ling Test"],
    ["config", "user.email", "ling-test@example.invalid"],
    ["add", "."],
    ["commit", "-m", "release harness fixture"],
  ]) {
    git(root, args);
  }
  return {
    root,
    repositoryPaths,
    scriptPaths,
    scriptContents,
    commit: git(root, ["rev-parse", "HEAD"]),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function git(cwd, args) {
  const result = spawnSync(macosSystemTool("git"), args, {
    cwd,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().toLowerCase();
}
