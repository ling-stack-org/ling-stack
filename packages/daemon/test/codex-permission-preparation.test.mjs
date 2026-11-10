import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexActionPreparer } from "../dist/runtime/adapters/codex/action-preparation.js";
import { CodexFileChangeContext } from "../dist/runtime/adapters/codex/file-change-context.js";
import { codexPermissionResponse } from "../dist/runtime/adapters/codex/permission-preparation.js";

function fixture(t, overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-codex-permission-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const policy = { policy: { toolDecisions: { bash: "ask", read: "allow", write: "ask", edit: "ask" }, allowedWritePaths: [cwd] }, ...overrides };
  return { cwd, actions: new CodexActionPreparer(cwd, policy, new CodexFileChangeContext()) };
}
function request(cwd, permissions, extra = {}) {
  return { id: "permission-request", method: "item/permissions/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "permission-1", environmentId: null,
    startedAtMs: 1, cwd, reason: "Read the project this turn", permissions, ...extra,
  } };
}
const pathEntry = (path, access = "read") => ({ path: { type: "path", path }, access });

test("native network request is a turn-scope proposal, never Bash or a once grant", t => {
  const f = fixture(t);
  const prepared = f.actions.prepare(request(f.cwd, { network: { enabled: true }, fileSystem: null }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.approval.actionType, "runtime_permission_request");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.match(prepared.approval.title, /^Risk review required:/);
  assert.match(prepared.approval.description, /Runtime permission expansion requires risk review/);
  assert.deepEqual(prepared.approval.payload, { type: "native_permission_request", version: 1, scope: "turn",
    cwd: f.cwd, reason: "Read the project this turn", resources: [{ kind: "network", access: "connect" }] });
});

test("native entries override legacy projections instead of merging a hidden write grant", t => {
  const f = fixture(t);
  const prepared = f.actions.prepare(request(f.cwd, { network: null, fileSystem: {
    read: [f.cwd], write: ["/"], entries: [pathEntry(f.cwd)],
  } }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.deepEqual(prepared.approval.payload.resources, [{ kind: "filesystem", access: "read", target: { kind: "path", path: f.cwd } }]);
});

test("deny entries, read globs, symbolic roots and scan depth remain in the proposal", t => {
  const f = fixture(t);
  const prepared = f.actions.prepare(request(f.cwd, { network: null, fileSystem: {
    read: null, write: null, globScanMaxDepth: 4, entries: [
      { access: "read", path: { type: "glob_pattern", pattern: `${f.cwd}/src/**/*.ts` } },
      { access: "read", path: { type: "special", value: { kind: "project_roots", subpath: "docs" } } },
      pathEntry(`${f.cwd}/private`, "deny"),
    ],
  } }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.equal(prepared.approval.payload.fileSystemScanDepth, 4);
  assert.deepEqual(prepared.approval.payload.resources, [
    { kind: "filesystem", access: "read", target: { kind: "glob", pattern: `${f.cwd}/src/**/*.ts` } },
    { kind: "filesystem", access: "read", target: { kind: "special", name: "project_roots", subpath: "docs" } },
    { kind: "filesystem", access: "deny", target: { kind: "path", path: `${f.cwd}/private` } },
  ]);
  const reply = codexPermissionResponse(prepared.approval.payload, true);
  assert.deepEqual(reply.permissions.fileSystem, {
    read: null, write: null, globScanMaxDepth: 4, entries: [
      { access: "read", path: { type: "glob_pattern", pattern: `${f.cwd}/src/**/*.ts` } },
      { access: "read", path: { type: "special", value: { kind: "project_roots", subpath: "docs" } } },
      pathEntry(`${f.cwd}/private`, "deny"),
    ],
  });
  assert.equal(reply.scope, "turn");
  reply.permissions.fileSystem.entries.length = 0;
  assert.equal(prepared.approval.payload.resources.length, 3);
});

test("legacy write paths receive shared scope checks and preserve explicit requested resources", t => {
  const f = fixture(t);
  const prepared = f.actions.prepare(request(f.cwd, { network: null, fileSystem: { read: null, write: [`${f.cwd}/output.txt`] } }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.ok(prepared.approval.payload.resources.some(entry => entry.access === "write" && entry.target.path === `${f.cwd}/output.txt`));
});

test("write policy denial cannot be overridden by approving a native scope", t => {
  const f = fixture(t, { policy: { toolDecisions: { write: "deny", edit: "ask", bash: "ask" }, allowedWritePaths: ["."] } });
  const prepared = f.actions.prepare(request(f.cwd, { fileSystem: { write: [join(f.cwd, "output")], read: null }, network: null }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "deny");
});

for (const overrides of [
  { effectivePolicySnapshot: { conversationMode: "plan" } },
  { effectivePolicySnapshot: { workspaceAccessMode: "read_only" } },
  { approvalProfile: { mode: "strict" } },
  { approvalProfile: { mode: "standard", requiredForActions: ["external_send"] } },
]) test(`broad native permission retains stronger policy: ${JSON.stringify(overrides)}`, t => {
  const f = fixture(t, overrides);
  const prepared = f.actions.prepare(request(f.cwd, { network: { enabled: true }, fileSystem: null }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "deny");
});

test("write scope checks outside paths, internal state and symlink replacement", t => {
  const f = fixture(t);
  for (const path of [join(f.cwd, "../outside"), join(f.cwd, ".ling-stack/state.db")]) {
    const prepared = f.actions.prepare(request(f.cwd, { network: null, fileSystem: { read: null, write: [path] } }));
    assert.equal(prepared.kind, "action");
    assert.equal(prepared.policyDecision.decision, "deny", path);
  }
  mkdirSync(join(f.cwd, ".ling-stack"));
  const original = request(f.cwd, { network: null, fileSystem: { read: null, write: [join(f.cwd, "alias/file")] } });
  const prepared = f.actions.prepare(original);
  assert.equal(prepared.policyDecision.decision, "ask");
  symlinkSync(join(f.cwd, ".ling-stack"), join(f.cwd, "alias"), "dir");
  assert.throws(() => f.actions.assertCurrent(original, prepared));
});

test("empty entries cannot fall back to a hidden legacy grant", t => {
  const f = fixture(t);
  assert.equal(f.actions.prepare(request(f.cwd, { network: null, fileSystem: { read: [f.cwd], write: null, entries: [] } })).kind, "unsupported");
});

test("workspace-wide write permissions must retain the internal-state exclusion", t => {
  const f = fixture(t);
  const permissions = { network: null, fileSystem: { read: null, write: null, entries: [pathEntry(f.cwd, "write")] } };
  assert.equal(f.actions.prepare(request(f.cwd, permissions)).policyDecision.decision, "deny");
  permissions.fileSystem.entries.push(pathEntry(`${f.cwd}/.ling-stack`, "deny"));
  const prepared = f.actions.prepare(request(f.cwd, permissions));
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.deepEqual(codexPermissionResponse(prepared.approval.payload, true).permissions.fileSystem.entries, permissions.fileSystem.entries);
});

test("unproven write glob and symbolic expansion is explicit, not reinterpreted as an absolute root", t => {
  const f = fixture(t);
  for (const path of [
    { type: "glob_pattern", pattern: `${f.cwd}/**/*` },
    { type: "special", value: { kind: "tmpdir" } },
    { type: "special", value: { kind: "project_roots", subpath: null } },
  ]) {
    assert.deepEqual(f.actions.prepare(request(f.cwd, { network: null, fileSystem: { entries: [{ path, access: "write" }] } })),
      { kind: "unsupported", reason: "unproven_native_write_scope" });
  }
});

test("unknown fields, remote identity and malformed permission profiles are not grantable", t => {
  const f = fixture(t);
  for (const permissions of [null, {}, { network: { enabled: true, hosts: ["example.com"] } },
    { network: { enabled: "yes" } }, { network: { enabled: true }, unexpected: true },
    { fileSystem: { read: ["relative"], write: null } },
    { fileSystem: { read: [f.cwd], write: null, globScanMaxDepth: 0 } },
    { fileSystem: { entries: [{ access: ["write"], path: { type: "path", path: f.cwd } }] } },
    { fileSystem: { entries: [{ access: "read", path: { type: "special", value: { kind: ["root"] } } }] } },
    { fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "unknown", path: "future" } } }] } },
  ]) assert.equal(f.actions.prepare(request(f.cwd, permissions)).kind, "unsupported", JSON.stringify(permissions));
  for (const extra of [{ environmentId: "remote" }, { cwd: "/different" }, { scope: "session" }, { startedAtMs: "1" }]) {
    assert.equal(f.actions.prepare(request(f.cwd, { network: { enabled: true } }, extra)).kind, "unsupported");
  }
});
