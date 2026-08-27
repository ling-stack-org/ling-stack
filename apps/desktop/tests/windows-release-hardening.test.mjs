import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WINDOWS_RELEASE_HARNESS_FILES } from "./windows-acceptance-report.mjs";

const psPath = new URL("./run-windows-acceptance.ps1", import.meta.url);
const providerPath = new URL(
  "./verify-windows-cua-driver-provider.mjs",
  import.meta.url,
);
const providerSmokePath = new URL(
  "./run-windows-provider-smoke.mjs",
  import.meta.url,
);
const desktopMainPath = new URL("../main/main.ts", import.meta.url);
const releaseAttestationVerifierPath = new URL(
  "./verify-windows-release-attestations.mjs",
  import.meta.url,
);
const internalAttestationVerifierPath = new URL(
  "./verify-windows-internal-attestations.mjs",
  import.meta.url,
);
const policySchemaPath = new URL(
  "../../../docs/release/evidence/windows-release-policy.schema.json",
  import.meta.url,
);

test("Windows PowerShell acceptance is bounded, tree-cleaning, and stale-report safe", async () => {
  const source = await readFile(psPath, "utf8");
  assert.match(source, /function Stop-NativeProcessTree/u);
  assert.match(source, /System32\\taskkill\.exe/u);
  assert.match(source, /WaitForExit\(\$TimeoutMilliseconds\)/u);
  assert.doesNotMatch(source, /\b\d+_\d+\b/u);
  assert.match(source, /Remove-Item -LiteralPath \$outputPath -Force/u);
  assert.match(source, /function Resolve-TrustedToolPath/u);
  assert.match(source, /resolved outside a trusted tool root/u);
  assert.match(source, /-TimeoutMilliseconds 90000/u);
  assert.match(source, /-TimeoutMilliseconds 120000/u);
  assert.doesNotMatch(source, /Get-Command\s+nvda\.exe/u);
  assert.match(source, /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature/u);
  assert.match(source, /Microsoft\.PowerShell\.Utility\\Get-FileHash/u);
  assert.match(source, /signed installer payload roundtrip blocked before execution/u);
  assert.match(source, /signed_installer_cleanup_uninstaller_signature_invalid/u);
  assert.match(source, /signed_installer_cleanup_uninstaller_hash_invalid/u);
  assert.match(source, /signed_installer_vendor_native_inventory_mismatch/u);
  assert.match(source, /installedVendorNativeInventory/u);
  const harnessBlock = source.match(
    /\$releaseHarnessRelativePaths\s*=\s*@\(([\s\S]*?)\n\)/u,
  );
  assert.ok(harnessBlock);
  assert.deepEqual(
    [...harnessBlock[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]),
    WINDOWS_RELEASE_HARNESS_FILES,
  );
});

test("Windows Full acceptance accepts only an immutable cell handoff", async () => {
  const source = await readFile(psPath, "utf8");
  const providerSmokeSource = await readFile(providerSmokePath, "utf8");
  const desktopMainSource = await readFile(desktopMainPath, "utf8");
  assert.match(source, /\[string\]\$HandoffManifest/u);
  assert.match(
    source,
    /Full mode accepts only -HandoffManifest <windows-cell-handoff\.json>/u,
  );
  assert.match(source, /load-windows-cell-handoff\.mjs/u);
  assert.match(source, /\$fullHandoff\.expected\.candidateCommit/u);
  assert.match(source, /\$fullHandoff\.repositoryRoot/u);
  assert.match(source, /\$fullHandoff\.expected\.releasePolicySha256/u);
  assert.match(source, /\$fullHandoff\.indexSha256/u);
  assert.match(source, /\$fullHandoff\.manifestSha256/u);
  assert.match(source, /Assert-RequiredToolVersions/u);
  assert.match(source, /requiredToolVersions/u);
  assert.match(source, /--expected-candidate-commit/u);
  assert.match(source, /--expected-repository-root/u);
  assert.match(source, /--expected-release-policy-sha256/u);
  assert.doesNotMatch(source, /\[string\]\$CandidateManifest,/u);
  assert.doesNotMatch(source, /\[string\]\$ReleasePolicy,/u);
  assert.match(source, /schemaVersion\s*-ne\s*3/u);
  assert.match(source, /\$candidateManifestEvidence\.verified/u);
  assert.match(
    source,
    /ExpectedCandidateCommit does not match the clean acceptance harness commit/u,
  );
  assert.match(
    source,
    /Handoff repositoryRoot does not match the acceptance harness repository/u,
  );
  assert.match(
    source,
    /ExpectedReleasePolicySha256 does not match the supplied release policy/u,
  );
  assert.match(
    source,
    /\$finalReport\.summary\.releaseReady -ne \$false/u,
  );
  const looseDigestGuard = source.match(
    /function Assert-FullLooseArtifactDigests \{([\s\S]*?)\n\}/u,
  );
  assert.ok(looseDigestGuard);
  for (const role of [
    "lingInstaller",
    "lingApp",
    "provider",
    "providerSeal",
    "providerCatalog",
  ]) {
    assert.match(looseDigestGuard[1], new RegExp(`"${role}"`, "u"));
  }
  assert.match(
    looseDigestGuard[1],
    /windows_handoff_loose_artifact_digest_mismatch:\$role/u,
  );
  const handoffLoadedAt = source.indexOf("$fullHandoff = $handoffLoad.output");
  const installerInvokedAt = source.indexOf("Invoke-InstallerPayloadVerification `");
  const looseDigestChecks = [
    ...source.matchAll(/Assert-FullLooseArtifactDigests -Handoff \$fullHandoff/gu),
  ].map((match) => match.index);
  assert.equal(looseDigestChecks.length, 2);
  assert.ok(
    looseDigestChecks.every(
      (position) =>
        position > handoffLoadedAt && position < installerInvokedAt,
    ),
  );
  const installerRoundtrip = source.match(
    /function Invoke-InstallerPayloadVerification \{([\s\S]*?)\n\}/u,
  );
  assert.ok(installerRoundtrip);
  assert.match(installerRoundtrip[1], /\$ExpectedInstallerSha256/u);
  assert.match(
    installerRoundtrip[1],
    /windows_handoff_loose_artifact_digest_mismatch:lingInstaller/u,
  );
  assert.ok(
    installerRoundtrip[1].indexOf("ExpectedInstallerSha256") <
      installerRoundtrip[1].indexOf(
        '$install = Invoke-NativeCapture -FilePath $InstallerPath',
      ),
  );
  assert.match(source, /Residual TOCTOU/u);
  assert.match(
    source,
    /\$env:LING_CUA_DRIVER_COMMAND = \$null/u,
  );
  assert.match(
    source,
    /\$env:LING_CUA_DRIVER_SMOKE_EXPECTED_COMMAND = \$ProviderPath/u,
  );
  assert.match(
    providerSmokeSource,
    /delete desktopEnvironment\.LING_CUA_DRIVER_COMMAND/u,
  );
  assert.match(
    providerSmokeSource,
    /LING_CUA_DRIVER_SMOKE_EXPECTED_COMMAND/u,
  );
  assert.match(
    providerSmokeSource,
    /trusted-local:cua-driver/u,
  );
  assert.match(
    providerSmokeSource,
    /parseWindowsBundledProviderActivation/u,
  );
  const firstActivationAt = providerSmokeSource.indexOf(
    "const firstBundledActivation = await waitForBundledProviderActivation",
  );
  const firstRuntimeProofAt = providerSmokeSource.indexOf(
    "const firstRuntimeProof = assertWindowsBundledRuntimeProof",
  );
  const restartExitAt = providerSmokeSource.indexOf(
    "const firstResult = await waitForExit",
  );
  const oldChildExitAt = providerSmokeSource.indexOf(
    "await waitForWindowsProcessExit(firstRuntimeProof.providerProcessId",
  );
  const restartedActivationAt = providerSmokeSource.indexOf(
    "const restartedBundledActivation = await waitForBundledProviderActivation",
  );
  const restartedRuntimeProofAt = providerSmokeSource.indexOf(
    "const restartedRuntimeProof = assertWindowsBundledRuntimeProof",
  );
  assert.ok(firstActivationAt >= 0);
  assert.ok(firstActivationAt < firstRuntimeProofAt);
  assert.ok(firstRuntimeProofAt < restartExitAt);
  assert.ok(restartExitAt < oldChildExitAt);
  assert.ok(oldChildExitAt < restartedActivationAt);
  assert.ok(restartedActivationAt < restartedRuntimeProofAt);
  assert.equal(
    [...providerSmokeSource.matchAll(/assertWindowsBundledRuntimeProof\(\{/gu)].length,
    2,
  );
  assert.match(
    providerSmokeSource,
    /windows_provider_smoke_expected_provider_not_packaged/u,
  );
  assert.match(
    desktopMainSource,
    /desktop_windows_bundled_provider_authority_not_eligible/u,
  );
  assert.match(
    desktopMainSource,
    /providerHost\?\.state === "ready"/u,
  );
  assert.match(
    desktopMainSource,
    /desktop_windows_bundled_provider_executable_path_mismatch/u,
  );
  assert.match(
    desktopMainSource,
    /verifyWindowsDaemonBundledProviderTarget/u,
  );
  assert.match(
    desktopMainSource,
    /providerChildInstanceNonceSha256/u,
  );
});

test("Windows release promotion requires policy-pinned reviewer and candidate-build signatures", async () => {
  const source = await readFile(releaseAttestationVerifierPath, "utf8");
  const internalSource = await readFile(internalAttestationVerifierPath, "utf8");
  assert.match(source, /windowsAcceptanceMatrixEvidenceSha256/u);
  assert.match(source, /reviewerKeys/u);
  assert.match(source, /candidateBuildAttestors/u);
  assert.match(source, /publicKeySpkiSha256/u);
  assert.match(source, /WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS/u);
  assert.match(source, /expectedProfile:\s*"production"/u);
  assert.match(source, /flag:\s*"wx"/u);
  assert.match(internalSource, /expectedProfile:\s*"internal"/u);
  assert.match(internalSource, /promotionStatus:\s*"INTERNAL_TEST_PASS"/u);
  assert.match(internalSource, /releaseReady:\s*false/u);
  assert.match(internalSource, /production_signing_required/u);
  assert.doesNotMatch(internalSource, /releaseReady:\s*true/u);
});

test("provider verifier does not resolve PowerShell or unzip through PATH", async () => {
  const source = await readFile(providerPath, "utf8");
  assert.match(source, /resolveWindowsSystemExecutable\(/u);
  assert.match(source, /resolveWindowsSystemExecutable\("taskkill\.exe"\)/u);
  assert.match(source, /resolveUnzipExecutable\(/u);
  assert.match(source, /\[System\.IO\.Path\]::Combine\(\$PSHOME/u);
  assert.match(source, /Microsoft\.PowerShell\.Core\\+Import-Module/u);
  assert.match(source, /Microsoft\.PowerShell\.Security\\+Get-AuthenticodeSignature/u);
  assert.doesNotMatch(source, /runChild\(\s*["']powershell\.exe["']/u);
  assert.doesNotMatch(source, /runChild\(\s*["']unzip["']/u);
  assert.match(source, /detached: process\.platform !== "win32"/u);
});

test("release policy cannot omit the supported build and signer certificate bindings", async () => {
  const schema = JSON.parse(await readFile(policySchemaPath, "utf8"));
  assert.ok(schema.required.includes("supportedWindowsBuilds"));
  assert.ok(schema.required.includes("lingSignerCertificateSha256"));
  assert.ok(schema.required.includes("providerSignerCertificateSha256"));
  assert.ok(schema.required.includes("manualEvidenceReviewers"));
  assert.ok(schema.required.includes("reviewerKeys"));
  assert.ok(schema.required.includes("candidateBuildAttestors"));
  assert.equal(schema.properties.schemaVersion.const, 3);
  assert.equal(
    schema.properties.lingSignerCertificateSha256.$ref,
    "#/$defs/sha256",
  );
});
