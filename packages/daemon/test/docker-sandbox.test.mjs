import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDockerSandboxRunPlan,
  checkDockerSandboxBackend,
} from "../dist/runtime/sandbox/docker.js";

test("docker sandbox doctor verifies backend and builds a network-disabled run plan", async () => {
  const commands = [];
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "ling-sandbox:test",
      cpus: 2,
      memoryMb: 1024,
    },
    env: { NODE_ENV: "test" },
    secretEnvRefs: { OPENAI_API_KEY: "env:OPENAI_API_KEY" },
  }, async (file, args) => {
    commands.push({ file, args });
    return { stdout: "ok", stderr: "" };
  });

  assert.equal(check.ok, true);
  assert.equal(check.profile.backendKind, "docker");
  assert.equal(check.profile.backendVerified, true);
  assert.equal(check.profile.networkPolicy.mode, "disabled");
  assert.equal(check.readiness.status, "ready");
  assert.deepEqual(check.readiness.blockingReasons, []);
  assert.deepEqual(commands.map((command) => command.args.slice(0, 2)), [
    ["info", "--format"],
    ["image", "inspect"],
  ]);

  const plan = buildDockerSandboxRunPlan({
    check,
    command: ["node", "--version"],
  });
  assert.equal(plan.networkMode, "none");
  assert.equal(plan.workspaceMount.mode, "read_only");
  assert.equal(plan.secretEnvNames.includes("OPENAI_API_KEY"), true);
  assert.equal(plan.args.includes("--network"), true);
  assert.equal(plan.args.includes("none"), true);
  assert.equal(plan.args.includes("--cpus"), true);
  assert.equal(plan.args.includes("2"), true);
  assert.equal(plan.args.includes("--memory"), true);
  assert.equal(plan.args.includes("1024m"), true);
  assert.equal(plan.args.at(-3), "ling-sandbox:test");
  assert.equal(plan.args.at(-2), "node");
  assert.equal(plan.args.at(-1), "--version");
  assert.equal(JSON.stringify(plan).includes("env:OPENAI_API_KEY"), false);
});

test("docker sandbox doctor blocks when docker daemon is unavailable", async () => {
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "ling-sandbox:test",
    },
  }, async (_file, args) => {
    if (args[0] === "info") {
      throw new Error("docker is not running");
    }
    return { stdout: "ok", stderr: "" };
  });

  assert.equal(check.ok, false);
  assert.equal(check.profile.backendVerified, false);
  assert.equal(diagnosticCodes(check).includes("docker_daemon_unreachable"), true);
  assert.equal(blockerCodes(check).includes("sandbox_backend_unverified"), true);
  assert.throws(
    () => buildDockerSandboxRunPlan({ check }),
    /sandbox_backend_unverified/,
  );
});

test("docker sandbox doctor blocks unavailable images", async () => {
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "missing:test",
    },
  }, async (_file, args) => {
    if (args[0] === "image") {
      throw new Error("image not found");
    }
    return { stdout: "ok", stderr: "" };
  });

  assert.equal(check.ok, false);
  assert.equal(diagnosticCodes(check).includes("docker_image_unavailable"), true);
  assert.equal(blockerCodes(check).includes("sandbox_backend_unverified"), true);
});

test("docker sandbox keeps non-disabled network policy blocked in P12", async () => {
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "ling-sandbox:test",
      networkPolicy: { mode: "allowlist", allowedHosts: ["example.com"] },
    },
  }, async () => ({ stdout: "ok", stderr: "" }));

  assert.equal(check.ok, false);
  assert.equal(diagnosticCodes(check).includes("docker_network_policy_unimplemented"), true);
  assert.equal(blockerCodes(check).includes("sandbox_network_policy_unverified"), true);
  assert.throws(
    () => buildDockerSandboxRunPlan({ check }),
    /sandbox_network_policy_unverified/,
  );
});

test("docker sandbox manifest inherits raw-secret fail-closed checks", async () => {
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "ling-sandbox:test",
    },
    env: { OPENAI_API_KEY: "sk-test-secret-value" },
  }, async () => ({ stdout: "ok", stderr: "" }));

  assert.equal(check.ok, false);
  assert.equal(blockerCodes(check).includes("sandbox_manifest_contains_raw_secret"), true);
});

test("docker sandbox requires artifact import root under Ling artifacts", async () => {
  const check = await checkDockerSandboxBackend({
    workspaceRoot: "/tmp/ling-workspace",
    config: {
      enabled: true,
      image: "ling-sandbox:test",
      artifactImportRoot: "/tmp/outside-artifacts",
    },
  }, async () => ({ stdout: "ok", stderr: "" }));

  assert.equal(check.ok, false);
  assert.equal(diagnosticCodes(check).includes("docker_artifact_import_root_invalid"), true);
  assert.equal(blockerCodes(check).includes("sandbox_artifact_import_unverified"), true);
});

function diagnosticCodes(check) {
  return check.diagnostics.map((diagnostic) => diagnostic.code);
}

function blockerCodes(check) {
  return check.readiness.blockingReasons.map((blocker) => blocker.code);
}
