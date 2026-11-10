// Synthetic verifier evidence for deterministic tests; never real engine/platform certification.
export function fixtureNativeAcceptance(identity) {
  const { profileId, profileRevision, configurationFingerprint, workspaceId, ...releaseIdentity } = identity;
  return { schemaVersion: 1, id: "fixture-host", identity,
    verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    checks: { installation: "passed", authentication: "passed", connection: "passed", workspace_binding: "passed" },
    releaseEvidenceId: "fixture-release", release: { schemaVersion: 1, id: "fixture-release", identity: releaseIdentity,
      verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      checks: Object.fromEntries(["protocol", "permissions", "workspace", "artifacts", "cancellation", "recovery", "real_runtime", "packaged"].map(key => [key, "passed"])) } };
}

export function fixtureNativePolicy(engineId) {
  return { schemaVersion: 2, workspaceId: "test-workspace", defaultRunnerId: "pi", allowedRunnerIds: ["pi", engineId],
    explicitRunnerFallback: "disabled", implicitRunnerFallback: "disabled", updatedAt: "2026-10-18T00:00:00.000Z" };
}
