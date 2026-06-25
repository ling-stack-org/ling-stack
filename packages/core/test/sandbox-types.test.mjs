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

test("sandbox readiness accepts every first-class policy profile id when evidence is verified", () => {
  for (const policyProfileId of ["read_only", "workspace_write", "trusted_local", "danger_full_access"]) {
    const profile = {
      ...verifiedProfile(),
      policyProfileId,
    };
    const report = evaluateLingSandboxReadiness({ profile });

    assert.equal(report.status, "ready");
    assert.deepEqual(report.blockingReasons, []);
  }
});

test("sandbox readiness accepts a verified platform-native profile", () => {
  const profile = {
    ...verifiedProfile(),
    id: "platform-native-local",
    displayName: "Platform native local sandbox",
    backendKind: "platform_native",
    executionWrapper: {
      kind: "macos_sandbox_exec",
      verified: true,
      executableRef: "/usr/bin/sandbox-exec",
    },
    capabilities: [
      "process_isolation",
      "filesystem_isolation",
      "artifact_export",
      "network_policy",
      "secret_ref_injection",
    ],
  };
  const report = evaluateLingSandboxReadiness({
    profile,
    manifest: {
      schemaVersion: 1,
      profileId: profile.id,
      workspaceRoot: "/workspace/project",
      artifactImportRoots: ["/workspace/project/.ling/artifacts/platform-native"],
      networkPolicy: { mode: "disabled" },
      secretEnvRefs: { OPENAI_API_KEY: "keychain:OPENAI_API_KEY" },
    },
    sessionRef: {
      schemaVersion: 1,
      profileId: profile.id,
      backendKind: "platform_native",
      opaqueSessionId: "platform_native_session_1",
      createdAt: "2026-06-19T03:00:00.000Z",
    },
  });

  assert.equal(report.status, "ready");
  assert.equal(report.backendKind, "platform_native");
  assert.deepEqual(report.blockingReasons, []);
});

test("sandbox readiness blocks unverified policy, unsupported OS, and missing execution wrapper", () => {
  const profile = {
    ...verifiedProfile(),
    policyVerified: false,
    hostOsSupported: false,
    executionWrapper: {
      kind: "none",
      verified: false,
    },
  };
  const report = evaluateLingSandboxReadiness({ profile });

  assert.equal(report.status, "blocked");
  assert.deepEqual(blockerCodes(report), [
    "sandbox_policy_unverified",
    "sandbox_os_unsupported",
    "sandbox_execution_wrapper_missing",
  ]);
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
    policyProfileId: "read_only",
    policyVerified: true,
    hostOsSupported: true,
    capabilities: ["filesystem_isolation", "artifact_export", "network_policy"],
    backendVerified: true,
    artifactImportVerified: true,
    networkPolicyVerified: true,
    networkPolicy: { mode: "disabled" },
    artifactImport: {
      importRoot: "/workspace/project/.ling/artifacts",
      requireRedaction: true,
    },
    executionWrapper: {
      kind: "external",
      verified: true,
      evidenceRef: "test:verified-wrapper",
    },
  };
}

function blockerCodes(report) {
  return report.blockingReasons.map((blocker) => blocker.code);
}
