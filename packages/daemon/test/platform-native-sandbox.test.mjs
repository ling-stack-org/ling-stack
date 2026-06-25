import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPlatformNativeSandboxRunPlan,
  checkPlatformNativeSandboxBackend,
} from "../dist/runtime/sandbox/platform-native.js";

test("platform-native sandbox doctor verifies macOS sandbox-exec and builds a network-disabled run plan", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "darwin",
    now: "2026-06-19T04:00:00.000Z",
    config: {
      enabled: true,
      policyVerified: true,
      executionWrapperVerified: true,
      executionWrapperEvidenceRef: "test:macos-sandbox-exec-wrapper",
      macosSandboxExecPath: "/usr/bin/sandbox-exec",
      networkPolicy: { mode: "disabled" },
    },
    env: { LING_STACK_RUN_ID: "run_platform_native" },
    secretEnvRefs: { OPENAI_API_KEY: "keychain:OPENAI_API_KEY" },
  }, async (file) => file === "/usr/bin/sandbox-exec");

  assert.equal(check.ok, true);
  assert.equal(check.profile.backendKind, "platform_native");
  assert.equal(check.profile.policyProfileId, "read_only");
  assert.equal(check.profile.executionWrapper.verified, true);
  assert.equal(check.readiness.status, "ready");
  assert.equal(check.enforcement.kind, "macos_sandbox_exec");
  assert.equal(check.sessionRef.opaqueSessionId.startsWith("platform-native-"), true);

  const plan = buildPlatformNativeSandboxRunPlan({
    check,
    command: ["/bin/echo", "ok"],
  });
  assert.equal(plan.executable, "/usr/bin/sandbox-exec");
  assert.deepEqual(plan.args.slice(-2), ["/bin/echo", "ok"]);
  assert.equal(plan.networkMode, "disabled");
  assert.equal(plan.sandboxProfile.includes("(deny network*)"), true);
  assert.equal(plan.sandboxProfile.includes("/workspace/project/.ling/artifacts/sandbox/platform-native"), true);
  assert.deepEqual(plan.env, { LING_STACK_RUN_ID: "run_platform_native" });
  assert.deepEqual(plan.secretEnvNames, ["OPENAI_API_KEY"]);
});

test("platform-native sandbox blocks unsupported host platforms", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "linux",
    config: {
      enabled: true,
      policyVerified: true,
      executionWrapperVerified: true,
    },
  }, async () => true);

  assert.equal(check.ok, false);
  assert.equal(check.readiness.status, "blocked");
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_unsupported_platform"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), [
    "sandbox_backend_unverified",
    "sandbox_os_unsupported",
    "sandbox_execution_wrapper_missing",
  ]);
});

test("platform-native sandbox blocks missing enforcer and allowlist networking", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "darwin",
    config: {
      enabled: true,
      policyVerified: true,
      executionWrapperVerified: true,
      macosSandboxExecPath: "/missing/sandbox-exec",
      networkPolicy: { mode: "allowlist", allowedHosts: ["api.openai.com"] },
    },
  }, async () => false);

  assert.equal(check.ok, false);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_enforcer_missing"), true);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_execution_wrapper_missing"), true);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_network_policy_unimplemented"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), [
    "sandbox_backend_unverified",
    "sandbox_execution_wrapper_missing",
    "sandbox_network_policy_unverified",
  ]);
  assert.throws(
    () => buildPlatformNativeSandboxRunPlan({ check }),
    /Platform-native sandbox is not ready/,
  );
});

test("platform-native sandbox requires artifact import under Ling artifacts", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "darwin",
    config: {
      enabled: true,
      policyVerified: true,
      executionWrapperVerified: true,
      macosSandboxExecPath: "/usr/bin/sandbox-exec",
      artifactImportRoot: "/tmp/outside-ling-artifacts",
    },
  }, async () => true);

  assert.equal(check.ok, false);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_artifact_import_root_invalid"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), ["sandbox_artifact_import_unverified"]);
});

test("platform-native sandbox blocks missing policy and execution wrapper evidence", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "darwin",
    config: {
      enabled: true,
      macosSandboxExecPath: "/usr/bin/sandbox-exec",
    },
  }, async () => true);

  assert.equal(check.ok, false);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_policy_unverified"), true);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_execution_wrapper_missing"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), [
    "sandbox_policy_unverified",
    "sandbox_execution_wrapper_missing",
  ]);
});
