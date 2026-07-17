import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const psPath = new URL("./run-windows-acceptance.ps1", import.meta.url);
const providerPath = new URL(
  "./verify-windows-cua-driver-provider.mjs",
  import.meta.url,
);
const releaseAttestationVerifierPath = new URL(
  "./verify-windows-release-attestations.mjs",
  import.meta.url,
);
const workflowPath = new URL(
  "../../../.github/workflows/desktop-artifacts.yml",
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
});

test("Windows Full acceptance requires and forwards external trust anchors", async () => {
  const source = await readFile(psPath, "utf8");
  assert.match(source, /\[string\]\$ExpectedCandidateCommit/u);
  assert.match(source, /\[string\]\$ExpectedRepositoryRoot/u);
  assert.match(source, /\[string\]\$ExpectedReleasePolicySha256/u);
  assert.match(
    source,
    /Full mode requires -ExpectedCandidateCommit from the release orchestrator/u,
  );
  assert.match(
    source,
    /Full mode requires -ExpectedRepositoryRoot from the release orchestrator/u,
  );
  assert.match(
    source,
    /Full mode requires -ExpectedReleasePolicySha256 from the release orchestrator/u,
  );
  assert.match(source, /--expected-candidate-commit/u);
  assert.match(source, /--expected-repository-root/u);
  assert.match(source, /--expected-release-policy-sha256/u);
  assert.match(source, /verify-windows-release-attestations\.mjs/u);
  assert.match(source, /\$policy\.schemaVersion -eq 2/u);
  assert.match(source, /\$manifest\.schemaVersion -eq 3/u);
  assert.match(source, /daemonPayload\.treeSha256/u);
  assert.match(
    source,
    /ExpectedCandidateCommit does not match the clean acceptance harness commit/u,
  );
  assert.match(
    source,
    /ExpectedRepositoryRoot does not match the acceptance harness repository/u,
  );
  assert.match(
    source,
    /ExpectedReleasePolicySha256 does not match the supplied release policy/u,
  );
  assert.match(
    source,
    /\$finalReport\.summary\.releaseReady -ne \$true/u,
  );
});

test("Windows release promotion requires policy-pinned reviewer and candidate-build signatures", async () => {
  const source = await readFile(releaseAttestationVerifierPath, "utf8");
  assert.match(source, /windowsAcceptanceEvidenceSha256/u);
  assert.match(source, /reviewerKeys/u);
  assert.match(source, /candidateBuildAttestors/u);
  assert.match(source, /publicKeySpkiSha256/u);
  assert.match(source, /trusted_external_signature/u);
  assert.match(source, /WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS/u);
  assert.match(source, /await rm\(outputPath, \{ force: true \}\)/u);
  assert.match(source, /await rename\(temporaryOutputPath, outputPath\)/u);
  assert.doesNotMatch(source, /releaseReady:\s*true[\s\S]*not_verified/u);
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

test("hosted Windows preflight requires the diagnostic gates that prove its own lifecycle", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /candidate-binding/u);
  assert.match(source, /install-cleanliness/u);
  assert.match(source, /provider-verification/u);
  assert.match(source, /provider-smoke/u);
  assert.match(source, /did not prove \{0\}/u);
  assert.match(source, /function Invoke-BoundedProcess/u);
  assert.match(source, /System32\/taskkill\.exe/u);
});

test("release policy cannot omit the supported build and signer certificate bindings", async () => {
  const schema = JSON.parse(await readFile(policySchemaPath, "utf8"));
  assert.ok(schema.required.includes("supportedWindowsBuilds"));
  assert.ok(schema.required.includes("lingSignerCertificateSha256"));
  assert.ok(schema.required.includes("providerSignerCertificateSha256"));
  assert.ok(schema.required.includes("manualEvidenceReviewers"));
  assert.ok(schema.required.includes("reviewerKeys"));
  assert.ok(schema.required.includes("candidateBuildAttestors"));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(
    schema.properties.lingSignerCertificateSha256.pattern,
    "^[0-9a-f]{64}$",
  );
});
