import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compileExecutionSandboxPolicy, createDefaultApprovalPolicy, resolveSessionRunPolicy } from "@ling-stack/core";
import { buildMacosSeatbeltProfile, MACOS_DYLD_PROFILE, MACOS_SYSTEM_READ_ROOTS } from "../dist/runtime/sandbox/macos-seatbelt-profile.js";
import { macosSandboxCommandFingerprint, prepareMacosSandboxCommand, readMacosSandboxBackendIdentity, signalMacosSandboxProcessGroup } from "../dist/runtime/sandbox/macos-native-command.js";

const now = "2026-09-07T00:00:00.000Z";
const backend = { kind: "macos_seatbelt", protocolVersion: 1, helperVersion: "fixture", executableSha256: "a".repeat(64) };
const shell = command => ({ kind: "shell", command });
const echo = { kind: "argv", argv: ["/bin/echo", "unit"] };
function policyInput(command = echo, alter = () => {}) {
  const input = {
    now, platform: "darwin", tool: "bash", workspaceRoot: "/fixture/workspace", cwd: "/fixture/workspace",
    temporaryRoot: "/fixture/temp", runtimeReadRoots: [...MACOS_SYSTEM_READ_ROOTS], deniedReadRoots: ["/fixture/private"], protectedWriteRoots: [], backend, grants: [],
    binding: { workspaceId: "test", runId: "run", workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "runtime",
      fencingToken: "9007199254740993", toolCallId: "tool", operationHash: macosSandboxCommandFingerprint(command, "/fixture/workspace", "/fixture/temp") },
    policy: resolveSessionRunPolicy({ workspacePolicy: createDefaultApprovalPolicy("test", now), authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot,
  };
  alter(input);
  return input;
}
const compile = alter => compileExecutionSandboxPolicy(policyInput(echo, alter));

test("profile is deny-default and imports only the fixed dyld bootstrap", () => {
  const profile = buildMacosSeatbeltProfile(compile());
  assert.ok(profile.startsWith("(version 1)\n(deny default)\n"));
  assert.ok(profile.includes('(import "' + MACOS_DYLD_PROFILE + '")'));
  assert.equal(profile.match(/\(import /g).length, 1);
  assert.ok(!profile.includes("(allow default)") && !profile.includes("system.sb"));
  assert.ok(!MACOS_SYSTEM_READ_ROOTS.includes("/System"));
});
test("profile intersects allow roots with protected exclusions", () => {
  const profile = buildMacosSeatbeltProfile(compile());
  assert.match(profile, /\(allow file-write\* \(require-all .* \(require-not /);
  assert.match(profile, /\(deny file-read\* file-map-executable /);
  assert.match(profile, /\(deny file-write\* /);
  for (const directory of [".git", ".ling", ".agents", ".codex"]) assert.ok(profile.includes("/fixture/workspace/" + directory));
});
test("only dedicated scratch is writable, not all of tmp", () => {
  const profile = buildMacosSeatbeltProfile(compile());
  assert.ok(profile.includes('(subpath "/fixture/temp")'));
  for (const path of ["/tmp", "/private/tmp", "/System"]) assert.ok(!profile.includes('(subpath "' + path + '")'));
});
test("profile quotes path syntax rather than interpolating rules", () => {
  const path = '/fixture/quoted" (allow default) \\name';
  const profile = buildMacosSeatbeltProfile(compile(input => { input.runtimeReadRoots.push(path); }));
  assert.ok(profile.includes('(subpath "/fixture/quoted\\" (allow default) \\\\name")'));
});
test("network defaults to disabled and only a bound scope enables it", () => {
  assert.ok(buildMacosSeatbeltProfile(compile()).endsWith("(deny network*)"));
  const policy = compile(input => { input.grants.push({ id: "grant", approvalId: "approval", binding: { ...input.binding }, cwd: input.cwd,
    scope: { kind: "command_network" }, status: "approved", createdAt: now, expiresAt: "2026-09-07T01:00:00.000Z" }); });
  assert.ok(buildMacosSeatbeltProfile(policy).endsWith("(allow network*)"));
  assert.equal(policy.networkMode, "single_call_allowed");
});
for (const [label, alter] of [
  ["other platforms", policy => ({ ...policy, platform: "win32" })],
  ["full access", policy => ({ ...policy, executionMode: "full_access" })],
  ["missing filesystem", policy => ({ ...policy, filesystem: null })],
  ["wrong backend", policy => ({ ...policy, backend: { ...backend, kind: "windows_restricted" } })],
]) test("profile rejects " + label, () => {
  assert.throws(() => buildMacosSeatbeltProfile(alter(compile())), /macos_restricted_policy_required/);
});
test("fingerprint normalizes the supported shell aliases", () => {
  const fingerprints = [undefined, "bash", "/bin/bash"].map(value => macosSandboxCommandFingerprint({ ...shell("echo yes"), shell: value }, "/cwd", "/temp"));
  assert.equal(new Set(fingerprints).size, 1);
});
test("fingerprint binds the fixed Electron Node environment and resource identity", () => {
  const profile = { kind: "electron_node_v1", resourceIdentitySha256: "a".repeat(64) };
  const plain = macosSandboxCommandFingerprint(echo, "/cwd", "/temp");
  const electron = macosSandboxCommandFingerprint(echo, "/cwd", "/temp", profile);
  assert.notEqual(electron, plain);
  assert.notEqual(electron, macosSandboxCommandFingerprint(echo, "/cwd", "/temp",
    { ...profile, resourceIdentitySha256: "b".repeat(64) }));
  for (const invalid of [null, {}, { ...profile, kind: "custom" }, { ...profile, resourceIdentitySha256: "bad" },
    { ...profile, env: { NODE_OPTIONS: "--require private.cjs" } }]) {
    assert.throws(() => macosSandboxCommandFingerprint(echo, "/cwd", "/temp", invalid), /macos_runtime_profile_invalid/);
  }
});
test("fingerprint binds command, cwd, temp and argument boundaries", () => {
  const values = [
    [echo, "/cwd", "/temp"], [{ kind: "argv", argv: ["/bin/echo", "other"] }, "/cwd", "/temp"],
    [echo, "/other", "/temp"], [echo, "/cwd", "/other"],
    [{ kind: "argv", argv: ["/bin/echo", "a b"] }, "/cwd", "/temp"],
    [{ kind: "argv", argv: ["/bin/echo", "a", "b"] }, "/cwd", "/temp"], [shell("echo unit"), "/cwd", "/temp"],
  ].map(args => macosSandboxCommandFingerprint(...args));
  assert.equal(new Set(values).size, values.length);
  assert.match(values[0], /^[a-f0-9]{64}$/);
});
for (const [label, command] of [
  ["empty argv", { kind: "argv", argv: [] }],
  ["relative executable", { kind: "argv", argv: ["echo"] }],
  ["NUL argv", { kind: "argv", argv: ["/bin/echo", "a\0b"] }],
  ["non-string argv", { kind: "argv", argv: ["/bin/echo", 4] }],
  ["too many arguments", { kind: "argv", argv: ["/bin/echo", ...Array(256).fill("x")] }],
  ["aggregate oversized argv", { kind: "argv", argv: ["/bin/echo", "x".repeat(70_000), "x".repeat(70_000)] }],
  ["blank shell", shell(" ")], ["NUL shell", shell("a\0b")],
  ["oversized shell", shell("x".repeat(131_073))],
  ["unsupported shell", { ...shell("echo yes"), shell: "/bin/zsh" }],
  ["unknown command", { kind: "other", command: "echo yes" }],
]) test("fingerprint rejects " + label, () => {
  assert.throws(() => macosSandboxCommandFingerprint(command, "/cwd", "/temp"), /macos_command_invalid|macos_shell_unsupported/);
});
test("command byte limits accept the documented boundary", () => {
  assert.match(macosSandboxCommandFingerprint({ kind: "argv", argv: ["/bin/echo", "x".repeat(131_061)] }, "/cwd", "/temp"), /^[a-f0-9]{64}$/);
  assert.throws(() => macosSandboxCommandFingerprint({ kind: "argv", argv: ["/bin/echo", "x".repeat(131_062)] }, "/cwd", "/temp"), /macos_command_invalid/);
});
test("unowned process objects cannot be used to signal arbitrary groups", () => {
  const invented = { pid: process.pid, exitCode: null, signalCode: null };
  assert.throws(() => signalMacosSandboxProcessGroup(invented, "SIGTERM"), /macos_process_group_not_owned/);
  assert.throws(() => signalMacosSandboxProcessGroup(invented, "SIGUSR1"), /macos_process_group_not_owned/);
});
test("launcher rejects non-restricted policies before any native work", () => {
  assert.throws(() => prepareMacosSandboxCommand({ policy: { ...compile(), executionMode: "full_access" }, command: echo }), /macos_restricted_policy_required/);
});
test("launcher rejects a mutable snapshot or changed hash", () => {
  const policy = compile();
  assert.throws(() => prepareMacosSandboxCommand({ policy: { ...policy }, command: echo }), /macos_policy_integrity_invalid/);
  assert.throws(() => prepareMacosSandboxCommand({ policy: Object.freeze({ ...policy, cwd: "/changed" }), command: echo }), /macos_policy_integrity_invalid/);
});

// No command is spawned here. Real native execution belongs to the explicit OS smoke suite.
if (process.platform === "darwin") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-macos-prepare-unit-")));
  const workspace = join(root, "workspace"), scratch = join(root, "scratch");
  for (const path of [workspace, scratch]) mkdirSync(path, { mode: 0o700 });
  const make = (alter = () => {}) => compileExecutionSandboxPolicy(policyInput(echo, input => {
    Object.assign(input, { workspaceRoot: workspace, cwd: workspace, temporaryRoot: scratch, deniedReadRoots: [],
      backend: readMacosSandboxBackendIdentity() });
    input.runtimeReadRoots.push(dirname(realpathSync(process.execPath)));
    input.binding.operationHash = macosSandboxCommandFingerprint(echo, workspace, scratch);
    alter(input);
  }));
  test("system backend identity is fixed, hashed and frozen", () => {
    const value = readMacosSandboxBackendIdentity();
    assert.equal(value.kind, "macos_seatbelt");
    assert.ok(Object.isFrozen(value));
    assert.match(value.helperVersion, /^ling-seatbelt-v1:[^:]+:[a-f0-9]{64}$/);
    assert.match(value.executableSha256, /^[a-f0-9]{64}$/);
  });
  test("preparation is immutable and does not assert descendant quiescence", () => {
    const prepared = prepareMacosSandboxCommand({ policy: make(), command: echo });
    assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.environmentKeys));
    assert.equal(prepared.lifecycleScope, "process_group");
    assert.equal(prepared.descendantStopProof, "not_available");
    assert.deepEqual(prepared.environmentKeys, ["HOME", "LANG", "LING_STACK_SANDBOX", "PATH", "PWD", "TMPDIR"]);
  });
  test("changed backend identity fails closed", () => {
    const policy = make(input => { input.backend = { ...input.backend, executableSha256: "0".repeat(64) }; });
    assert.throws(() => prepareMacosSandboxCommand({ policy, command: echo }), /macos_backend_identity_changed/);
  });
  test("Electron mode cannot borrow a plain environment policy, or vice versa", () => {
    const runtimeProfile = { kind: "electron_node_v1", resourceIdentitySha256: "a".repeat(64) };
    const policy = make(input => {
      input.binding.operationHash = macosSandboxCommandFingerprint(echo, workspace, scratch, runtimeProfile);
    });
    assert.throws(() => prepareMacosSandboxCommand({ policy, command: echo }), /macos_command_binding_mismatch/);
    assert.throws(() => prepareMacosSandboxCommand({ policy: make(), command: echo, runtimeProfile }), /macos_command_binding_mismatch/);
    const prepared = prepareMacosSandboxCommand({ policy, command: echo, runtimeProfile });
    assert.deepEqual(prepared.environmentKeys, ["ELECTRON_RUN_AS_NODE", "HOME", "LANG", "LING_STACK_SANDBOX", "PATH", "PWD", "TMPDIR"]);
  });
  test("missing runtime roots fail before spawn", () => {
    assert.throws(() => prepareMacosSandboxCommand({ policy: make(input => { input.runtimeReadRoots = []; }), command: echo }), /macos_runtime_roots_missing/);
  });
  test("command mismatch cannot borrow a valid policy", () => {
    assert.throws(() => prepareMacosSandboxCommand({ policy: make(), command: shell("echo changed") }), /macos_command_binding_mismatch/);
  });
  test("unresolvable and symlink read roots are rejected", () => {
    const link = join(root, "link");
    symlinkSync(workspace, link);
    for (const path of [link, join(root, "absent")]) {
      assert.throws(() => prepareMacosSandboxCommand({ policy: make(input => { input.runtimeReadRoots.push(path); }), command: echo }), /macos_canonical_path_required|macos_path_missing/);
    }
  });
  test("temporary directory must be private", () => {
    const path = join(root, "public-temp");
    mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o755);
    const policy = make(input => { input.temporaryRoot = path; input.binding.operationHash = macosSandboxCommandFingerprint(echo, workspace, path); });
    assert.throws(() => prepareMacosSandboxCommand({ policy, command: echo }), /macos_temporary_root_not_private/);
  });
  test("replaced runtime path invalidates a prepared invocation", () => {
    const path = join(root, "replaceable");
    mkdirSync(path, { mode: 0o700 });
    const prepared = prepareMacosSandboxCommand({ policy: make(input => { input.runtimeReadRoots.push(path); }), command: echo });
    renameSync(path, path + "-original"); mkdirSync(path, { mode: 0o700 });
    assert.throws(() => prepared.spawn(() => { throw new Error("authority must not be reached"); }), /macos_path_identity_changed/);
  });
  test("fresh authority refusal consumes the invocation without spawning", () => {
    const prepared = prepareMacosSandboxCommand({ policy: make(), command: echo });
    assert.throws(() => prepared.spawn(() => { throw new Error("stale-fence"); }), /stale-fence/);
    assert.throws(() => prepared.spawn(() => {}), /macos_launch_already_consumed/);
  });
  test("Promise authority is not accepted as synchronous permission", () => {
    const prepared = prepareMacosSandboxCommand({ policy: make(), command: echo });
    assert.throws(() => prepared.spawn(async () => {}), /macos_authority_check_must_be_synchronous/);
  });
} else {
  test("system backend rejects unsupported OS without running sandbox-exec", () => {
    assert.throws(() => readMacosSandboxBackendIdentity(), /macos_backend_unavailable/);
    assert.throws(() => prepareMacosSandboxCommand({ policy: compile(), command: echo }), /macos_backend_unavailable/);
  });
}
