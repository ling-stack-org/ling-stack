import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../dist/index.js";

const now = "2026-09-07T08:00:00.000Z";
const before = "2026-09-07T07:00:00.000Z";
const after = "2026-09-07T09:00:00.000Z";
const compile = input => core.compileExecutionSandboxPolicy(input);
function fixture(access = "workspace_write", authorization = "always") {
  return {
    now, platform: "darwin",
    binding: { workspaceId: "workspace-a", runId: "run-a", workUnitId: "unit-a", attemptId: "attempt-a",
      runtimeInstanceId: "runtime-a", fencingToken: "9007199254740993", toolCallId: "tool-a", operationHash: "a".repeat(64) },
    tool: "write", workspaceRoot: "/fixture/workspace", cwd: "/fixture/workspace",
    temporaryRoot: "/fixture/tmp/attempt-a", runtimeReadRoots: ["/usr/lib"],
    deniedReadRoots: ["/fixture/private/state"], protectedWriteRoots: ["/fixture/repo-common.git"],
    backend: { kind: "macos_seatbelt", helperVersion: "0.1.0-dev.0", protocolVersion: 1, executableSha256: "b".repeat(64) },
    policy: core.resolveSessionRunPolicy({ workspacePolicy: core.createDefaultApprovalPolicy("workspace-a", before),
      authorizationMode: authorization, workspaceAccessMode: access }).snapshot,
    grants: [],
  };
}
function grant(input, scope, id = "grant-a") {
  return { id, approvalId: `approval:${id}`, binding: { ...input.binding }, cwd: input.cwd, scope,
    status: "approved", createdAt: before, expiresAt: after };
}
function blocked(input, code) {
  assert.throws(() => compile(input), error => error?.code === code && error.message === code);
}

test("restricted policy is immutable, call-bound and not a readiness declaration", () => {
  const input = fixture();
  const policy = compile(input);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.executionMode, "native_required");
  assert.equal(policy.networkMode, "disabled");
  assert.equal(policy.approvalDecision, "allow");
  assert.equal(policy.binding.fencingToken, "9007199254740993");
  assert.deepEqual(policy.filesystem.writeRoots, ["/fixture/workspace"]);
  for (const name of [".git", ".agents", ".codex", ".ling"]) assert.ok(policy.filesystem.deniedWriteRoots.includes(`/fixture/workspace/${name}`));
  assert.ok(policy.filesystem.deniedReadRoots.includes("/fixture/workspace/.ling"));
  assert.ok(policy.filesystem.deniedWriteRoots.includes("/fixture/repo-common.git"));
  assert.match(policy.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(policy, "enforcementReady"), false);
  input.binding.runId = "changed";
  input.runtimeReadRoots.push("/unrelated");
  assert.equal(policy.binding.runId, "run-a");
  assert.ok(!policy.filesystem.readRoots.includes("/unrelated"));
  assert.throws(() => policy.filesystem.writeRoots.push("/outside"), TypeError);
  assert.throws(() => { policy.binding.fencingToken = "2"; }, TypeError);
});

test("sorting and duplicate roots do not change the policy hash", () => {
  const first = fixture();
  first.runtimeReadRoots = ["/System/Library", "/usr/lib", "/usr/lib/"];
  const second = structuredClone(first);
  second.runtimeReadRoots.reverse();
  second.runtimeReadRoots.push("/System/Library");
  assert.equal(compile(first).policyHash, compile(second).policyHash);
});

for (const [name, change] of [
  ["attempt", input => { input.binding.attemptId = "attempt-b"; }],
  ["operation", input => { input.binding.operationHash = "c".repeat(64); }],
  ["policy revision", input => { input.policy.workspacePolicyUpdatedAt = "2026-09-07T07:30:00.000Z"; }],
  ["backend identity", input => { input.backend.executableSha256 = "c".repeat(64); }],
  ["cwd", input => { input.cwd = "/fixture/workspace/subdir"; }],
]) test(name + " changes policy identity", () => {
  const input = fixture();
  const prior = compile(input).policyHash;
  change(input);
  assert.notEqual(compile(input).policyHash, prior);
});

test("existing command ask survives always/workspace-write until actual OS integration", () => {
  const input = fixture();
  input.tool = "bash";
  assert.equal(compile(input).approvalDecision, "ask");
  assert.equal(core.resolveSessionRunPolicy({ workspacePolicy: core.createDefaultApprovalPolicy("workspace-a", before), authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot.toolDecisions.bash, "ask");
});

test("read-only compilation has no project write scope and denies general command or mutation", () => {
  const input = fixture("read_only");
  input.tool = "read";
  assert.deepEqual(compile(input).filesystem.writeRoots, []);
  for (const tool of ["bash", "write", "edit"]) { input.tool = tool; blocked(input, "operation_denied"); }
});

test("explicit deny and Plan Mode cannot be overridden by grants", () => {
  const input = fixture();
  input.policy.toolDecisions.write = "deny";
  input.grants.push(grant(input, { kind: "write_roots", roots: ["/fixture/extra"] }));
  blocked(input, "operation_denied");
  input.policy.toolDecisions.write = "allow";
  input.policy.conversationMode = "plan";
  input.policy.planModeMutationPolicy = "deny_repo_tracked_mutation";
  blocked(input, "operation_denied");
  input.tool = "read";
  input.grants = [];
  assert.deepEqual(compile(input).filesystem.writeRoots, []);
});

test("full access is explicit and never claims filesystem or command-network isolation", () => {
  const input = fixture("full_access");
  blocked(input, "full_access_confirmation_required");
  input.permissionConfirmation = { mode: "full_access", confirmed: true, confirmedAt: before, reason: "Approved for this authenticated conversation" };
  delete input.backend;
  const result = compile(input);
  assert.equal(result.executionMode, "full_access");
  assert.equal(result.networkMode, "unrestricted");
  assert.equal(result.filesystem, null);
  assert.equal(result.backend, null);
  assert.ok(!JSON.stringify(result).includes(input.permissionConfirmation.reason));
});

test("current Host-normalized legacy snapshots remain subject to access restrictions", () => {
  const input = fixture("read_only");
  input.tool = "read";
  delete input.policy.authorizationMode;
  delete input.policy.workspaceAccessMode;
  input.policy.mode = "ask_everything";
  assert.equal(compile(input).workspaceAccessMode, "read_only");
  input.tool = "bash";
  blocked(input, "operation_denied");
  input.policy.mode = "custom";
  blocked(input, "ambiguous_legacy_policy");
});

test("extra directories require typed grants and retain default protected paths", () => {
  const input = fixture();
  input.grants = [grant(input, { kind: "read_roots", roots: ["/fixture/shared-read"] }), grant(input, { kind: "write_roots", roots: ["/fixture/shared-write"] }, "grant-b")];
  const result = compile(input);
  assert.ok(result.filesystem.readRoots.includes("/fixture/shared-read"));
  assert.ok(result.filesystem.readRoots.includes("/fixture/shared-write"));
  assert.ok(result.filesystem.writeRoots.includes("/fixture/shared-write"));
  assert.ok(!result.filesystem.writeRoots.includes("/fixture/shared-read"));
  assert.equal(result.networkMode, "disabled");
  assert.equal(result.grants.length, 2);
  assert.equal(compile({ ...input, grants: [...input.grants].reverse() }).policyHash, result.policyHash);
});

test("network grant is single exact command scope, not a persistent permission", () => {
  const input = fixture();
  input.tool = "bash";
  input.grants = [grant(input, { kind: "command_network" })];
  assert.equal(compile(input).networkMode, "single_call_allowed");
  assert.equal(compile({ ...input, grants: [] }).networkMode, "disabled");
  input.binding.toolCallId = "next-command";
  blocked(input, "grant_binding_mismatch");
  input.binding.toolCallId = "tool-a";
  input.tool = "read";
  blocked(input, "grant_scope_incompatible");
});

for (const [name, change, code] of [
  ["expired", value => { value.grants[0].expiresAt = now; }, "grant_not_current"],
  ["revoked", value => { value.grants[0].status = "revoked"; }, "grant_not_current"],
  ["pending approval", value => { value.grants[0].status = "pending"; }, "grant_not_current"],
  ["future grant", value => { value.grants[0].createdAt = after; }, "grant_not_current"],
  ["different run", value => { value.grants[0].binding.runId = "run-b"; }, "grant_binding_mismatch"],
  ["different fence", value => { value.grants[0].binding.fencingToken = "9007199254740994"; }, "grant_binding_mismatch"],
  ["different workspace", value => { value.grants[0].binding.workspaceId = "workspace-b"; }, "grant_binding_mismatch"],
  ["different operation", value => { value.grants[0].binding.operationHash = "d".repeat(64); }, "grant_binding_mismatch"],
  ["different cwd", value => { value.grants[0].cwd = "/fixture/workspace/other"; }, "grant_binding_mismatch"],
  ["duplicate grant", value => { value.grants.push(structuredClone(value.grants[0])); }, "invalid_grant"],
  ["untyped permission", value => { value.grants[0].scope = { kind: "full_access" }; }, "invalid_grant"],
  ["protected write", value => { value.grants[0].scope.roots = ["/fixture/workspace/.git/hooks"]; }, "protected_scope"],
  ["secret read", value => { value.grants[0].scope = { kind: "read_roots", roots: ["/fixture/private/state/secrets"] }; }, "protected_scope"],
]) test(name + " cannot compile an execution grant", () => {
  const input = fixture();
  input.grants = [grant(input, { kind: "write_roots", roots: ["/fixture/shared"] })];
  change(input);
  blocked(input, code);
});

for (const [name, change, code] of [
  ["outside default writes", value => { value.policy.allowedWritePaths = ["../outside"]; }, "write_scope_outside_workspace"],
  ["prefix sibling cwd", value => { value.cwd = "/fixture/workspace-other"; }, "cwd_outside_scope"],
  ["global workspace", value => { value.workspaceRoot = "/"; }, "invalid_sandbox_path"],
  ["shared temporary root", value => { value.temporaryRoot = "/fixture/workspace/tmp"; }, "temporary_scope_overlap"],
  ["secret temporary root", value => { value.temporaryRoot = "/fixture/private"; }, "temporary_scope_overlap"],
  ["invalid fence", value => { value.binding.fencingToken = "1e10"; }, "invalid_execution_binding"],
  ["missing backend", value => { delete value.backend; }, "backend_identity_required"],
  ["backend claimed ready", value => { value.backend.verified = true; }, "invalid_backend_identity"],
  ["wrong OS backend", value => { value.backend.kind = "windows_restricted"; }, "invalid_backend_identity"],
]) test(name + " fails closed", () => { const input = fixture(); change(input); blocked(input, code); });

test("Windows policy treats paths as native paths and preserves Chinese names", () => {
  const input = fixture();
  Object.assign(input, { platform: "win32", workspaceRoot: "C:\\工作区\\项目", cwd: "c:\\工作区\\项目\\src",
    temporaryRoot: "C:\\LingTmp\\attempt-a", runtimeReadRoots: ["C:\\Windows\\System32"],
    deniedReadRoots: ["C:\\LingPrivate"], protectedWriteRoots: ["C:\\repo-common.git"],
    backend: { ...input.backend, kind: "windows_restricted" } });
  const result = compile(input);
  assert.ok(result.filesystem.writeRoots.includes("C:\\工作区\\项目"));
  assert.ok(result.filesystem.deniedWriteRoots.includes("C:\\工作区\\项目\\.git"));
  for (const bad of ["C:\\", "\\\\server\\share", "\\\\?\\C:\\workspace", "C:\\path:ads", "C:\\work.\\project", "C:\\work\\NUL.txt", "C:relative", "\\relative"]) {
    blocked({ ...input, workspaceRoot: bad }, "invalid_sandbox_path");
  }
  blocked({ ...input, cwd: "C:\\工作区\\项目-other" }, "cwd_outside_scope");
  for (const root of ["C:relative", "D:relative"]) {
    blocked({ ...input, policy: { ...input.policy, allowedWritePaths: [root] } }, "invalid_sandbox_path");
  }
});

test("invalid directory collections produce fixed errors without echoing private input", () => {
  for (const key of ["deniedReadRoots", "protectedWriteRoots", "runtimeReadRoots"]) {
    const input = fixture();
    input[key] = null;
    blocked(input, "invalid_sandbox_path");
    input[key] = Array.from({ length: 129 }, () => "/fixture/private-marker");
    blocked(input, "invalid_sandbox_path");
  }
});

test("temporary output cannot overlap trusted runtime libraries", () => {
  const input = fixture();
  input.temporaryRoot = "/usr/lib/writable-temp";
  blocked(input, "temporary_scope_overlap");
});

test("runtime allow roots cannot directly expose a protected credential directory", () => {
  const input = fixture();
  input.runtimeReadRoots = ["/fixture/private/state"];
  blocked(input, "protected_scope");
});

test("all independent permission combinations preserve the existing explicit decisions", () => {
  for (const access of ["read_only", "workspace_write", "full_access"]) {
    for (const authorization of ["ask", "smart", "always"]) {
      const input = fixture(access, authorization);
      input.permissionConfirmation = { mode: "full_access", confirmed: true, confirmedAt: before, reason: "fixture explicit confirmation" };
      input.tool = "read";
      assert.equal(compile(input).workspaceAccessMode, access);
      assert.equal(compile(input).authorizationMode, authorization);
      input.tool = "write";
      if (access === "read_only") blocked(input, "operation_denied");
      else assert.equal(compile(input).approvalDecision, input.policy.toolDecisions.write);
    }
  }
});
