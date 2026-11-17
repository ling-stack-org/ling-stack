import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createInstalledDarwinLockedUseClientFactory } from "../dist/main/locked-computer-control/installed-native-client.js";
import type { DarwinIdentityCommandInput } from "../dist/main/cua-driver/adapters/darwin-identity.js";

const team = "ABCDE12345";
const root = "/Library/Application Support/LingStack/LockedUse";
const clientArtifact = "Client.app/Contents/MacOS/LingLockedUseClient";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(profile: "local_identity" | "local_development" = "local_identity",
  mutate?: (value: Record<string, unknown>) => void) {
  let helper = Buffer.from("fixture-signed-helper");
  const value: Record<string, unknown> = {
    schemaVersion: 1, platform: "darwin", architecture: process.arch, team,
    signing: profile, productCapability: "disabled_by_build", nativeAcceptance: "not_run",
    checks: { policy: "passed", authorizationPluginABI: "passed",
      kernelTaskVerifier: profile === "local_development" ? "local_development_identity_passed" : "identity_passed", xctest: "separate" },
    upstreamCommit: "e25be21caa0ea489316f6be6635d2a4766c4cd0b",
    artifacts: Object.fromEntries(["LingLockBroker", "LingLockInstaller", "Ling Guardian.app/Contents/MacOS/LingGuardian",
      clientArtifact, "LingLockAuth.bundle/Contents/MacOS/LingLockAuth"].map((path) => [path, hash(helper)])),
  };
  mutate?.(value);
  let manifest = Buffer.from(JSON.stringify(value));
  const reads: string[] = [];
  const commands: DarwinIdentityCommandInput[] = [];
  let metadata = `Authority=${profile === "local_development" ? "Apple Development: Fixture (ABCDE12345)" : "Developer ID Application: Fixture (ABCDE12345)"}\nIdentifier=com.lingstack.locked-use.client\nTeamIdentifier=${team}\nCodeDirectory v=20500 flags=0x12000(library-validation,runtime)`;
  let entitlements: Record<string, unknown> | undefined;
  let commandError: Error | undefined;
  let afterCommands: (() => void) | undefined;
  const options = {
    expectedTeamId: team, expectedBuildManifestSha256: hash(manifest),
    async readInstalledFile(path: string, limit: number) {
      reads.push(path);
      assert.ok(path === `${root}/build-manifest.json` || path === `${root}/${clientArtifact}`);
      const bytes = path.endsWith(".json") ? manifest : helper;
      assert.ok(bytes.byteLength <= limit);
      return bytes;
    },
    runner: { async run(input: DarwinIdentityCommandInput) {
      commands.push(input);
      if (commandError) throw commandError;
      if (input.args.includes("--verbose=4")) return { stdout: "", stderr: metadata };
      if (input.args.includes("--entitlements")) {
        afterCommands?.();
        return { stdout: entitlements ? "<plist version=\"1.0\"><dict/></plist>" : "", stderr: "" };
      }
      if (input.executable === "/usr/bin/plutil") return { stdout: JSON.stringify(entitlements), stderr: "" };
      return { stdout: "", stderr: "" };
    } },
  };
  return { options, reads, commands,
    metadata: (value: string) => { metadata = value; },
    entitlements: (value: Record<string, unknown>) => { entitlements = value; },
    commandError: (error: Error) => { commandError = error; },
    replaceHelper: () => { helper = Buffer.from("replacement-helper"); },
    replaceManifest: () => { manifest = Buffer.from("{}"); },
    afterCommands: (fn: () => void) => { afterCommands = fn; },
  };
}

test("installed factory verifies pinned bytes and Developer ID before each spawn, without promoting capability", async () => {
  const fx = fixture();
  const factory = createInstalledDarwinLockedUseClientFactory(fx.options);
  assert.deepEqual(Object.keys(factory).sort(), ["createClient", "verifyHelper"]);
  await factory.verifyHelper(); await factory.verifyHelper();
  assert.equal(fx.reads.filter((path) => path.endsWith(".json")).length, 4);
  assert.equal(fx.reads.filter((path) => path.endsWith("LingLockedUseClient")).length, 4);
  const verify = fx.commands.find((command) => command.args.some((arg) => arg.startsWith("-R=")))!;
  assert.equal(verify.args.at(-1), `${root}/Client.app`);
  assert.match(verify.args.join(" "), /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/u);
  assert.match(verify.args.join(" "), /ABCDE12345/u);
  const count = fx.commands.length;
  const client = factory.createClient(() => {});
  assert.equal(fx.commands.length, count);
  client.close();
});

test("local development profile accepts only Apple Development and its local manifest", async () => {
  const fx = fixture("local_development");
  const factory = createInstalledDarwinLockedUseClientFactory({ ...fx.options, expectedProfile: "local_development" });
  await factory.verifyHelper();
  const verify = fx.commands.find((command) => command.args.some((arg) => arg.startsWith("-R=")))!;
  assert.match(verify.args.join(" "), /ABCDE12345/u);
  assert.doesNotMatch(verify.args.join(" "), /1\.2\.840\.113635\.100\.6\.1\.13/u);
  fx.metadata("Authority=Developer ID Application: Fixture (ABCDE12345)\nIdentifier=com.lingstack.locked-use.client\nTeamIdentifier=ABCDE12345\nCodeDirectory v=20500 flags=0x12000(library-validation,runtime)");
  await assert.rejects(factory.verifyHelper(), /apple_development/u);
});

test("manifest and helper replacement fail before native execution", async () => {
  for (const boundary of ["manifest", "helper"] as const) {
    const fx = fixture();
    const factory = createInstalledDarwinLockedUseClientFactory(fx.options);
    if (boundary === "manifest") fx.replaceManifest(); else fx.replaceHelper();
    await assert.rejects(factory.verifyHelper(), /digest_mismatch/u);
    assert.equal(fx.commands.length, 0);
  }
});

test("expanded, ad hoc, cross-build and self-promoting manifests are rejected", async () => {
  const mutations = [
    (value: Record<string, unknown>) => { value.schemaVersion = true; },
    (value: Record<string, unknown>) => { value.signing = "adhoc"; },
    (value: Record<string, unknown>) => { value.team = "OTHER12345"; },
    (value: Record<string, unknown>) => { value.architecture = "other"; },
    (value: Record<string, unknown>) => { value.productCapability = "supported_restricted"; },
    (value: Record<string, unknown>) => { value.nativeAcceptance = "passed"; },
    (value: Record<string, unknown>) => { value.authorization = "renderer"; },
    (value: Record<string, unknown>) => { (value.checks as Record<string, unknown>).kernelTaskVerifier = "denial_passed"; },
    (value: Record<string, unknown>) => { (value.artifacts as Record<string, unknown>)[clientArtifact] = "a".repeat(64) + "\n"; },
  ];
  for (const mutate of mutations) {
    const fx = fixture("local_identity", mutate);
    await assert.rejects(createInstalledDarwinLockedUseClientFactory(fx.options).verifyHelper(), /manifest_invalid/u);
    assert.equal(fx.commands.length, 0);
  }
});

test("wrong signer, absent runtime and injection entitlements deny the helper", async () => {
  for (const metadata of [
    `Identifier=other\nTeamIdentifier=${team}\nCodeDirectory flags=0x10000(runtime)`,
    "Identifier=com.lingstack.locked-use.client\nTeamIdentifier=OTHER12345\nCodeDirectory flags=0x10000(runtime)",
    `Identifier=com.lingstack.locked-use.client\nTeamIdentifier=${team}\nCodeDirectory flags=0x0(none)`,
  ]) {
    const fx = fixture(); fx.metadata(`Authority=Developer ID Application: Fixture (ABCDE12345)\n${metadata}`);
    await assert.rejects(createInstalledDarwinLockedUseClientFactory(fx.options).verifyHelper(), /signing_identity_mismatch/u);
  }
  for (const entitlements of [{ "com.apple.security.get-task-allow": true }, { "com.apple.security.cs.disable-library-validation": true }]) {
    const fx = fixture(); fx.entitlements(entitlements);
    await assert.rejects(createInstalledDarwinLockedUseClientFactory(fx.options).verifyHelper(), /entitlements_invalid/u);
  }
  const empty = fixture(); empty.entitlements({});
  await createInstalledDarwinLockedUseClientFactory(empty.options).verifyHelper();
});

test("signature failures and replacements during verification cannot supply release proof", async () => {
  const failed = fixture(); failed.commandError(new Error("signature_denied"));
  await assert.rejects(createInstalledDarwinLockedUseClientFactory(failed.options).verifyHelper(), /signature_denied/u);
  for (const boundary of ["manifest", "helper"] as const) {
    const fx = fixture();
    fx.afterCommands(boundary === "manifest" ? fx.replaceManifest : fx.replaceHelper);
    await assert.rejects(createInstalledDarwinLockedUseClientFactory(fx.options).verifyHelper(), /digest_mismatch/u);
  }
});
