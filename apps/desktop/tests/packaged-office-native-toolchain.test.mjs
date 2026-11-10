import assert from "node:assert/strict";
import test from "node:test";
import { assertOfficeNativeToolchainProfile, OFFICE_NATIVE_HEADER_NAMES } from "../scripts/packaged-office-native-toolchain.mjs";

const profile = Object.freeze({ id: "synthetic-exact-profile", compilerVersionFirstLine: "Apple clang version 21.0.0 (clang-2100.3.34.2)",
  compilerSha256: "a".repeat(64), sdkCanonicalName: "macosx27.0", sdkVersion: "27.0", sdkSettingsSha256: "b".repeat(64) });
const headers = Object.freeze(Object.fromEntries(OFFICE_NATIVE_HEADER_NAMES.map(name => [name, "c".repeat(64)])));
function observation(root) {
  const { id, ...facts } = profile;
  return { compiler: { path: root + "/clang", version: profile.compilerVersionFirstLine, sha256: profile.compilerSha256 },
    sdk: { root: root + "/MacOSX.sdk", settingsSha256: profile.sdkSettingsSha256 },
    headers: { root: root + "/include/node", sha256: { ...headers } }, profile: facts };
}

test("exact tool identity policy permits installation-path relocation without granting approval", () => {
  for (const root of ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer", "/synthetic/fixture"])
    assert.equal(assertOfficeNativeToolchainProfile([profile], headers, observation(root)), profile.id);
});

test("exact tool identity policy rejects every compiler/SDK fact drift and header change", () => {
  for (const key of Object.keys(observation("/fixture").profile)) {
    const value = observation("/fixture"); value.profile[key] += "changed";
    assert.throws(() => assertOfficeNativeToolchainProfile([profile], headers, value), /toolchain_invalid/u);
  }
  for (const name of OFFICE_NATIVE_HEADER_NAMES) {
    const value = observation("/fixture"); value.headers.sha256[name] = "d".repeat(64);
    assert.throws(() => assertOfficeNativeToolchainProfile([profile], headers, value), /toolchain_invalid/u);
  }
});

test("exact tool identity policy rejects missing/extra fields, duplicate IDs and unbounded profiles", () => {
  for (const profiles of [[], [profile, profile], Array(17).fill(profile), [{ ...profile, id: "../outside" }],
    [{ ...profile, compilerVersionFirstLine: "clang version 21.0.0" }], [{ ...profile, sdkVersion: "*" }],
    [{ ...profile, extra: true }]]) {
    assert.throws(() => assertOfficeNativeToolchainProfile(profiles, headers, observation("/fixture")), /toolchain_invalid/u);
  }
  for (const change of [value => { delete value.profile.compilerSha256; }, value => { value.profile.extra = true; },
    value => { value.headers.sha256.extra = "d".repeat(64); }]) {
    const value = observation("/fixture"); change(value);
    assert.throws(() => assertOfficeNativeToolchainProfile([profile], headers, value), /toolchain_invalid/u);
  }
});
