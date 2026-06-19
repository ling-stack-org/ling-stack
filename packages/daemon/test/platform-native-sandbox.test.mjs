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
      macosSandboxExecPath: "/usr/bin/sandbox-exec",
      networkPolicy: { mode: "disabled" },
    },
    env: { LING_STACK_RUN_ID: "run_platform_native" },
    secretEnvRefs: { OPENAI_API_KEY: "keychain:OPENAI_API_KEY" },
  }, async (file) => file === "/usr/bin/sandbox-exec");

  assert.equal(check.ok, true);
  assert.equal(check.profile.backendKind, "platform_native");
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
    config: { enabled: true },
  }, async () => true);

  assert.equal(check.ok, false);
  assert.equal(check.readiness.status, "blocked");
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_unsupported_platform"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), ["sandbox_backend_unverified"]);
});

test("platform-native sandbox blocks missing enforcer and allowlist networking", async () => {
  const check = await checkPlatformNativeSandboxBackend({
    workspaceRoot: "/workspace/project",
    platform: "darwin",
    config: {
      enabled: true,
      macosSandboxExecPath: "/missing/sandbox-exec",
      networkPolicy: { mode: "allowlist", allowedHosts: ["api.openai.com"] },
    },
  }, async () => false);

  assert.equal(check.ok, false);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_enforcer_missing"), true);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_network_policy_unimplemented"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), [
    "sandbox_backend_unverified",
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
      macosSandboxExecPath: "/usr/bin/sandbox-exec",
      artifactImportRoot: "/tmp/outside-ling-artifacts",
    },
  }, async () => true);

  assert.equal(check.ok, false);
  assert.equal(check.diagnostics.some((diagnostic) => diagnostic.code === "platform_native_artifact_import_root_invalid"), true);
  assert.deepEqual(check.readiness.blockingReasons.map((blocker) => blocker.code), ["sandbox_artifact_import_unverified"]);
});
