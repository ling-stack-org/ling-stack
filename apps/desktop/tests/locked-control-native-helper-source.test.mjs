import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows locked-control helper uses user-mode identity/session APIs and contains no escalation path", async () => {
  const source = await readFile(new URL("../scripts/native/locked-control-win32.cpp", import.meta.url), "utf8");
  for (const required of [
    "UserConsentVerifier::RequestVerificationAsync",
    "ProcessIdToSessionId",
    "WTSQuerySessionInformationW",
    "OpenInputDesktop",
    "TokenStatistics",
    "SM_REMOTESESSION",
  ]) {
    assert.match(source, new RegExp(required.replaceAll("::", "\\:\\:")));
  }
  for (const forbidden of ["CreateService", "SERVICE_WIN32", "UIAccess", "WinSta0\\\\Winlogon"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /userDesktopTargeted[\s\S]*CreateBooleanValue\(false\)/u);
  assert.match(source, /secureSurfaceExcluded[\s\S]*CreateBooleanValue\(false\)/u);
});

test("Darwin locked-control helper uses LocalAuthentication and keeps locked attestation negative", async () => {
  const source = await readFile(new URL("../scripts/native/locked-control-darwin.swift", import.meta.url), "utf8");
  assert.match(source, /deviceOwnerAuthentication/u);
  assert.match(source, /SCDynamicStoreCopyConsoleUser/u);
  assert.match(source, /CGSSessionScreenIsLocked/u);
  assert.match(source, /"userDesktopTargeted": false/u);
  assert.match(source, /"secureSurfaceExcluded": false/u);
  assert.equal(source.includes("evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics"), false);
});

test("Windows handoff keeps signing explicit and every acceptance report non-promotional", async () => {
  const build = await readFile(new URL("../scripts/build-locked-control-native-helper.ps1", import.meta.url), "utf8");
  assert.match(build, /CertificateThumbprint/u);
  assert.match(build, /signtool\.exe sign/u);
  assert.match(build, /RequireSigned/u);
  assert.match(build, /Get-AuthenticodeSignature/u);

  const handoff = await readFile(new URL("../scripts/test-locked-control-win32-handoff.ps1", import.meta.url), "utf8");
  for (const mode of ["Baseline", "LockCycle", "WtsDisconnect", "UacDenial", "SessionZeroDenial"]) {
    assert.match(handoff, new RegExp(`"${mode}"`));
  }
  assert.match(handoff, /productCapability = "disabled_by_build"/u);
  assert.match(handoff, /acceptance = "handoff_probe_only"/u);
  assert.match(handoff, /locked_control_native_helper_attestation_must_remain_negative/u);
  for (const forbidden of ["password", "passcode", "credential", "CreateService"]) {
    assert.equal(handoff.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
});
