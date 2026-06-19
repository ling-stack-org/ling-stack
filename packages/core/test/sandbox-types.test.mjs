import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultLingSandboxNetworkPolicy,
  evaluateLingSandboxReadiness,
  normalizeLingSandboxNetworkPolicy,
} from "../dist/index.js";

test("sandbox readiness fails closed when the profile is missing", () => {
  const report = evaluateLingSandboxReadiness({});

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), ["sandbox_profile_missing"]);
});

test("sandbox readiness accepts a verified profile with disabled network policy", () => {
  const profile = verifiedProfile();
  const report = evaluateLingSandboxReadiness({
    profile,
    manifest: {
      schemaVersion: 1,
      profileId: profile.id,
      workspaceRoot: "/workspace/project",
      artifactImportRoots: ["/workspace/project/.ling/artifacts/sandbox"],
      env: { NODE_ENV: "test" },
      secretEnvRefs: { OPENAI_API_KEY: "env:OPENAI_API_KEY" },
    },
    sessionRef: {
      schemaVersion: 1,
      profileId: profile.id,
      backendKind: "local_unix",
      opaqueSessionId: "session_opaque_1",
      resumeTokenRef: "keychain:LING_SANDBOX_RESUME_TOKEN",
      createdAt: "2026-06-19T03:00:00.000Z",
    },
  });

  assert.equal(report.status, "ready");
  assert.deepEqual(report.blockingReasons, []);
});

test("sandbox readiness blocks unverified backend, artifacts, and network policy", () => {
  const profile = {
    ...verifiedProfile(),
    backendVerified: false,
    artifactImportVerified: false,
    networkPolicyVerified: false,
    networkPolicy: { mode: "allowlist", allowedHosts: [] },
  };
  const report = evaluateLingSandboxReadiness({ profile });

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), [
    "sandbox_backend_unverified",
    "sandbox_artifact_import_unverified",
    "sandbox_network_policy_unverified",
  ]);
});

test("sandbox manifest rejects raw secrets and invalid secret refs", () => {
  const profile = verifiedProfile();
  const report = evaluateLingSandboxReadiness({
    profile,
    manifest: {
      schemaVersion: 1,
      profileId: profile.id,
      workspaceRoot: "/workspace/project",
      artifactImportRoots: ["/workspace/project/.ling/artifacts/sandbox"],
      env: {
        OPENAI_API_KEY: "sk-test-secret-value",
        Authorization: "Bearer local-token",
      },
      secretEnvRefs: { GITHUB_TOKEN: "plain-token" },
    },
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), [
    "sandbox_manifest_contains_raw_secret",
    "sandbox_secret_ref_invalid",
  ]);
});

test("sandbox manifest requires artifacts to import into the Ling artifact root", () => {
  const profile = verifiedProfile();
  const report = evaluateLingSandboxReadiness({
    profile,
    manifest: {
      schemaVersion: 1,
      profileId: profile.id,
      workspaceRoot: "/workspace/project",
      artifactImportRoots: ["/tmp/sandbox-output"],
    },
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), ["sandbox_artifact_import_unverified"]);
});

test("sandbox session ref must match the verified profile and keep resume token as a secret ref", () => {
  const profile = verifiedProfile();
  const report = evaluateLingSandboxReadiness({
    profile,
    sessionRef: {
      schemaVersion: 1,
      profileId: "other-profile",
      backendKind: "docker",
      opaqueSessionId: "",
      resumeTokenRef: "raw-resume-token",
      createdAt: "2026-06-19T03:00:00.000Z",
    },
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), ["sandbox_session_ref_invalid"]);
});

test("sandbox network policy defaults to disabled", () => {
  assert.deepEqual(normalizeLingSandboxNetworkPolicy(undefined), defaultLingSandboxNetworkPolicy);
});

function verifiedProfile() {
  return {
    schemaVersion: 1,
    id: "local-readonly",
    displayName: "Local readonly sandbox",
    backendKind: "local_unix",
    capabilities: ["filesystem_isolation", "artifact_export", "network_policy"],
    backendVerified: true,
    artifactImportVerified: true,
    networkPolicyVerified: true,
    networkPolicy: { mode: "disabled" },
    artifactImport: {
      importRoot: "/workspace/project/.ling/artifacts",
      requireRedaction: true,
    },
  };
}

function blockerCodes(report) {
  return report.blockingReasons.map((blocker) => blocker.code);
}
