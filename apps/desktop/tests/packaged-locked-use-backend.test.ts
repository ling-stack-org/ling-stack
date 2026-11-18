import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadInstalledDarwinLockedUseBackend,
} from "../dist/main/locked-computer-control/packaged-darwin-backend.js";
import {
  LOCKED_USE_RELEASE_AUTHORITY_METADATA_KEY,
  loadPackagedDarwinLockedUseBackend,
} from "../dist/main/locked-computer-control/packaged-release-authority.js";
import type { LockedControlNativeStatusResponse } from "../dist/main/locked-computer-control/native-helper-bridge.js";

const team = "ABCDE12345";
const manifestDigest = "a".repeat(64);
const releaseAuthorityPath = (root: string) => join(root, "locked-use", "release-authority.json");
const optionsFor = (root: string) => ({ packaged: true, platform: "darwin", appPath: join(root, "app.asar"), resourcesRoot: root });

async function writePinnedAuthority(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, "locked-use"), { recursive: true });
  await mkdir(join(root, "app.asar"), { recursive: true });
  const bytes = `${JSON.stringify(value)}\n`;
  await writeFile(releaseAuthorityPath(root), bytes, "utf8");
  await writeFile(join(root, "app.asar", "package.json"), JSON.stringify({
    [LOCKED_USE_RELEASE_AUTHORITY_METADATA_KEY]: createHash("sha256").update(bytes).digest("hex"),
  }));
}

test("packaged Locked Use stays disabled without an exact release authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-authority-"));
  try {
    assert.equal(await loadPackagedDarwinLockedUseBackend({ ...optionsFor(root), packaged: false }), undefined);
    assert.equal(await loadPackagedDarwinLockedUseBackend({ ...optionsFor(root), platform: "win32" }), undefined);
    assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root)), undefined);
    assert.equal(await loadPackagedDarwinLockedUseBackend({ ...optionsFor(root), resourcesRoot: "relative" }), undefined);
    await mkdir(join(root, "locked-use"));
    await writeFile(releaseAuthorityPath(root), JSON.stringify(authority()));
    assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend: async () => { throw new Error("unanchored authority"); } }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release authority schema, acceptance marker and pinned digest are all required", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-authority-schema-"));
  try {
    await mkdir(join(root, "locked-use"), { recursive: true });
    const valid = authority();
    let calls = 0;
    const loadBackend = async (input: Parameters<typeof loadInstalledDarwinLockedUseBackend>[0]) => {
      calls += 1;
      assert.deepEqual(input, { expectedTeamId: team, expectedBuildManifestSha256: manifestDigest });
      return loadInstalledDarwinLockedUseBackend({ ...input, readStatus: async () => status("supported_restricted") });
    };
    for (const value of [
      { ...valid, schemaVersion: 2 },
      { ...valid, platform: "win32" },
      { ...valid, nativeAcceptance: "not_run" },
      { ...valid, expectedTeamId: "lowercase01" },
      { ...valid, expectedTeamId: "0000000000" },
      { ...valid, expectedBuildManifestSha256: "A".repeat(64) },
      { ...valid, extra: true },
    ]) {
      calls = 0;
      await writePinnedAuthority(root, value);
      assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend }), undefined);
      assert.equal(calls, 0);
    }
    await writePinnedAuthority(root, valid);
    const backend = await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend });
    assert.equal(backend?.capability.state, "supported_restricted");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release authority resource replacement and oversized input fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-authority-file-"));
  try {
    await writePinnedAuthority(root, authority());
    await rm(releaseAuthorityPath(root));
    const target = join(root, "authority-target.json");
    await writeFile(target, JSON.stringify(authority()), "utf8");
    await symlink(target, releaseAuthorityPath(root));
    assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend: async () => { throw new Error("must-not-load"); } }), undefined);
    await rm(releaseAuthorityPath(root));
    await writeFile(releaseAuthorityPath(root), "x".repeat(16 * 1024 + 1), "utf8");
    assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend: async () => { throw new Error("must-not-load"); } }), undefined);
    await writePinnedAuthority(root, authority());
    await writeFile(releaseAuthorityPath(root), `${JSON.stringify(authority({ expectedBuildManifestSha256: "b".repeat(64) }))}\n`);
    assert.equal(await loadPackagedDarwinLockedUseBackend(optionsFor(root), { loadBackend: async () => { throw new Error("replaced authority"); } }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed backend requires a live supported native status", async () => {
  const unsupported = await loadInstalledDarwinLockedUseBackend({
    expectedTeamId: team,
    expectedBuildManifestSha256: manifestDigest,
    readStatus: async () => status("probe_required"),
  });
  assert.equal(unsupported, undefined);

  const backend = await loadInstalledDarwinLockedUseBackend({
    expectedTeamId: team,
    expectedBuildManifestSha256: manifestDigest,
    readStatus: async () => status("supported_restricted"),
  });
  assert.ok(backend);
  assert.equal(backend.capability.state, "supported_restricted");
  assert.equal(backend.policy.mode, "task_grant_required");
  assert.equal(backend.policy.maxGrantTtlSeconds, 900);
});

test("target attestation requires the exact restricted provider and native readiness", async () => {
  const backend = await loadInstalledDarwinLockedUseBackend({
    expectedTeamId: team,
    expectedBuildManifestSha256: manifestDigest,
    readStatus: async () => status("supported_restricted"),
  });
  assert.ok(backend);
  const provider = {
    lifecycle: "active" as const,
    providerState: "ready" as const,
    generation: 8,
    pid: 1234,
    permissions: { accessibility: "granted" as const, screenRecording: "granted" as const, capturable: true },
  };
  const native = status("supported_restricted");
  assert.deepEqual(await backend.verifyTargetReadiness({ generation: 8, sessionBindingDigest: manifestDigest, providerSnapshot: provider, nativeStatus: native }), {
    userDesktopTargeted: true,
    captureReady: true,
    inputReady: true,
    secureSurfaceExcluded: true,
  });
  for (const changed of [
    { providerSnapshot: { ...provider, generation: 9 } },
    { providerSnapshot: { ...provider, pid: undefined } },
    { providerSnapshot: { ...provider, lifecycle: "starting" as const } },
    { providerSnapshot: { ...provider, providerState: "permission_required" as const } },
    { providerSnapshot: { ...provider, permissions: { ...provider.permissions, accessibility: "denied" as const } } },
    { providerSnapshot: { ...provider, permissions: { ...provider.permissions, screenRecording: "denied" as const } } },
    { providerSnapshot: { ...provider, permissions: { ...provider.permissions, capturable: false } } },
    { nativeStatus: status("probe_required") },
    { nativeStatus: { ...native, captureReady: false } },
    { nativeStatus: { ...native, inputReady: false } },
    { nativeStatus: { ...native, secureSurfaceExcluded: false } },
  ]) {
    const result = await backend.verifyTargetReadiness({ generation: 8, sessionBindingDigest: manifestDigest, providerSnapshot: changed.providerSnapshot ?? provider, nativeStatus: changed.nativeStatus ?? native });
    assert.equal(Object.values(result).every((value) => value === true), false);
  }
});

function authority(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    platform: "darwin",
    nativeAcceptance: "passed",
    expectedTeamId: team,
    expectedBuildManifestSha256: manifestDigest,
    ...overrides,
  };
}

function status(productCapability: LockedControlNativeStatusResponse["productCapability"]): LockedControlNativeStatusResponse {
  const supported = productCapability === "supported_restricted";
  return {
    platform: "darwin",
    productCapability,
    available: supported,
    captureReady: supported,
    inputReady: supported,
    secureSurfaceExcluded: supported,
  };
}
