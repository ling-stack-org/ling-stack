import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexActionPreparer } from "../dist/runtime/adapters/codex/action-preparation.js";
import { CodexFileChangeContext } from "../dist/runtime/adapters/codex/file-change-context.js";

function fixture(t, overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-native-action-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const context = new CodexFileChangeContext();
  const policy = { policy: { toolDecisions: { bash: "ask", write: "ask", edit: "ask" }, allowedWritePaths: [cwd] }, ...overrides };
  return { cwd, context, preparer: new CodexActionPreparer(cwd, policy, context) };
}
const identity = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" };
const command = (cwd, text, extra = {}) => ({ id: "request-1", method: "item/commandExecution/requestApproval",
  params: { ...identity, command: text, cwd, ...extra } });
const fileRequest = { id: "request-1", method: "item/fileChange/requestApproval", params: identity };
const change = (path = "file.txt", kind = { type: "update", move_path: null }) => ({ path, kind, diff: "-old\n+new" });
const event = (changes = [change()], overrides = {}) => ({ method: "item/started", params: {
  threadId: identity.threadId, turnId: identity.turnId,
  item: { type: "fileChange", id: identity.itemId, status: "inProgress", changes }, ...overrides,
} });

test("command classification preserves the exact native invocation and quoted arguments", t => {
  const f = fixture(t);
  const raw = "/usr/bin/whois 'example.com'";
  const prepared = f.preparer.prepare(command(f.cwd, raw));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.approval.payload.command, raw);
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.equal(prepared.approval.actionType, "bash");
});

test("named local command requires the accepted thread environment and retains one-time approval", t => {
  const f = fixture(t);
  const binding = { threadId: identity.threadId, configuration: { cwd: f.cwd }, localEnvironment: {
    environmentId: "local", cwd: f.cwd, runtimeWorkspaceRoots: [f.cwd],
  } };
  const request = command(f.cwd, "/bin/zsh -lc '/usr/bin/touch approved.txt'", {
    environmentId: "local", availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch"] } }, "cancel"],
  });
  assert.equal(f.preparer.prepare(request).kind, "unsupported");
  f.preparer.bindThreadEnvironment(binding);
  binding.localEnvironment.environmentId = "remote-1";
  const prepared = f.preparer.prepare(request);
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.equal(prepared.denialDecision, "cancel");
  assert.equal(prepared.approval.payload.command, request.params.command);
  f.preparer.assertCurrent(request, prepared);
  for (const changed of [{ environmentId: "remote-1" }, { threadId: "foreign-thread" }, { cwd: "/tmp/foreign-workspace" }, { cwd: `${f.cwd}/alias/..` },
    { additionalPermissions: { network: { enabled: true } } }, { networkApprovalContext: { host: "example.com" } }, { kind: "writeStdin" }]) {
    assert.equal(f.preparer.prepare({ ...request, params: { ...request.params, ...changed } }).kind, "unsupported");
  }
  assert.throws(() => f.preparer.bindThreadEnvironment(binding));
});

test("known shell wrappers and absolute executables cannot hide Plan Mode mutations", t => {
  const f = fixture(t, { effectivePolicySnapshot: { conversationMode: "plan" } });
  for (const text of ["/bin/zsh -lc 'touch file.txt'", "/bin/bash -c '/usr/bin/git commit -m fixture'", "/usr/bin/touch file.txt"]) {
    const prepared = f.preparer.prepare(command(f.cwd, text));
    assert.equal(prepared.kind, "action", text);
    assert.equal(prepared.policyDecision.decision, "deny", text);
    assert.match(prepared.policyDecision.reason, /Plan Mode/);
  }
});

test("wrapped git classification and native approval retain their explicit boundary despite tool allow", t => {
  const f = fixture(t, { policy: { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] },
    approvalProfile: { mode: "standard", requiredForActions: ["git_commit"] } });
  const git = f.preparer.prepare(command(f.cwd, "/bin/sh -c 'git commit -m fixture'"));
  assert.equal(git.approval.actionType, "git_commit");
  assert.equal(git.policyDecision.decision, "ask");
  assert.match(git.policyDecision.reason, /profile/);
  assert.equal(f.preparer.prepare(command(f.cwd, "whois example.com")).policyDecision.decision, "ask");
});

test("quoted force-push receives canonical risk classification", t => {
  const f = fixture(t);
  const result = f.preparer.prepare(command(f.cwd, "/bin/zsh -lc '\"git\" \"push\" \"--force\"'"));
  assert.equal(result.kind, "action");
  assert.equal(result.approval.risk, "critical");
  assert.ok(result.approval.payload.riskFlags.includes("git_force_push"));
});

for (const extra of [{ kind: "writeStdin" }, { environmentId: "remote-1" },
  { additionalPermissions: { network: { enabled: true } } }, { additionalPermissions: "malformed" },
  { networkApprovalContext: { host: "example.com" } }, { availableDecisions: "accept" }]) {
  test(`unmapped native command scope is explicit: ${JSON.stringify(extra)}`, t => {
    const f = fixture(t);
    assert.equal(f.preparer.prepare(command(f.cwd, "whois example.com", extra)).kind, "unsupported");
  });
}

test("missing native accept cannot be upgraded to a once grant", t => {
  const f = fixture(t);
  const prepared = f.preparer.prepare(command(f.cwd, "whois example.com", { availableDecisions: ["cancel"] }));
  assert.equal(prepared.policyDecision.decision, "deny");
  assert.equal(prepared.denialDecision, "cancel");
});

test("native amendment options do not replace the independently available one-time decision", t => {
  const f = fixture(t);
  const prepared = f.preparer.prepare(command(f.cwd, "whois example.com", { availableDecisions: [
    "accept", "acceptForSession", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["whois"] } },
    { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }, "decline",
  ] }));
  assert.equal(prepared.kind, "action");
  assert.equal(prepared.policyDecision.decision, "ask");
  assert.equal(prepared.approval.proposedCommandRule, undefined);
});

test("unmapped shell constructs and interpreter wrappers do not receive a misleading once proposal", t => {
  const f = fixture(t);
  for (const text of ["env git commit", "python3 -c 'print(1)'", "bash -c 'touch $TARGET'", "sudo git commit", "whois example.com && touch file.txt"]) {
    assert.equal(f.preparer.prepare(command(f.cwd, text)).kind, "unsupported", text);
  }
});

test("file preparation owns a cloned canonical item and checks every operation", t => {
  const f = fixture(t, { policy: { toolDecisions: { write: "deny", edit: "allow" }, allowedWritePaths: ["."] } });
  const started = event([change("source.txt"), change("added.txt", { type: "add" })]);
  f.context.receive(started);
  started.params.item.changes[1].path = "injected.txt";
  const result = f.preparer.prepare(fileRequest);
  assert.equal(result.kind, "action");
  assert.deepEqual(result.approval.payload.touchedPaths, ["source.txt", "added.txt"]);
  assert.equal(result.policyDecision.decision, "deny");
});

test("named local file approval uses only its bound thread item and retains all file scope checks", t => {
  const f = fixture(t);
  f.preparer.bindThreadEnvironment({ threadId: identity.threadId, configuration: { cwd: f.cwd }, localEnvironment: {
    environmentId: "local", cwd: f.cwd, runtimeWorkspaceRoots: [f.cwd],
  } });
  f.context.receive(event());
  const request = { ...fileRequest, params: { ...identity, environmentId: "local" } };
  const prepared = f.preparer.prepare(request);
  assert.equal(prepared.kind, "action");
  assert.deepEqual(prepared.approval.payload.touchedPaths, ["file.txt"]);
  assert.equal(prepared.policyDecision.decision, "ask");
  for (const changed of [{ environmentId: "remote-1" }, { threadId: "foreign-thread" }, { itemId: "missing-item" }, { grantRoot: f.cwd }]) {
    assert.equal(f.preparer.prepare({ ...request, params: { ...request.params, ...changed } }).kind, "unsupported");
  }
  const outside = event([change("../outside.txt")]);
  outside.params.item.id = "outside-item";
  f.context.receive(outside);
  assert.equal(f.preparer.prepare({ ...request, params: { ...request.params, itemId: "outside-item" } }).policyDecision.decision, "deny");
  f.context.receive({ ...event(), method: "item/completed" });
  assert.throws(() => f.preparer.assertCurrent(request, prepared));
});

test("move destinations, internal state and scope escapes are denied", t => {
  for (const entry of [change("source.txt", { type: "update", move_path: "../outside.txt" }), change(".ling-stack/state.db")]) {
    const f = fixture(t);
    f.context.receive(event([entry]));
    assert.equal(f.preparer.prepare(fileRequest).policyDecision.decision, "deny");
  }
});

test("file scope is rechecked after preparation, including symlink aliases to internal state", t => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, ".ling-stack"));
  f.context.receive(event([change("alias/state.db")]));
  const prepared = f.preparer.prepare(fileRequest);
  assert.equal(prepared.policyDecision.decision, "ask");
  symlinkSync(join(f.cwd, ".ling-stack"), join(f.cwd, "alias"), "dir");
  assert.throws(() => f.preparer.assertCurrent(fileRequest, prepared));
});

test("completed and foreign items cannot supply approval context", t => {
  const f = fixture(t);
  f.context.receive(event(undefined, { turnId: "different-turn" }));
  assert.equal(f.preparer.prepare(fileRequest).kind, "unsupported");
  f.context.receive(event());
  const prepared = f.preparer.prepare(fileRequest);
  f.context.receive({ ...event(), method: "item/completed" });
  assert.throws(() => f.preparer.assertCurrent(fileRequest, prepared));
  assert.equal(f.preparer.prepare(fileRequest).kind, "unsupported");
  assert.throws(() => f.context.receive(event()), { code: "protocol_error" });
});

test("file context rejects changed duplicates, invalid shape and bounded capacity exhaustion", () => {
  const context = new CodexFileChangeContext({ items: 1, bytes: 1024 });
  context.receive(event());
  context.receive(event());
  assert.throws(() => context.receive(event([change("other.txt")])), { code: "protocol_error" });
  assert.throws(() => context.receive(event(undefined, { turnId: "turn-2" })), { code: "capacity_exceeded" });
  const small = new CodexFileChangeContext({ items: 1, bytes: 8 });
  assert.throws(() => small.receive(event()), { code: "capacity_exceeded" });
  assert.throws(() => new CodexFileChangeContext().receive(event([{ path: "file", kind: { type: "unknown" }, diff: "x" }])));
});

test("turn completion immediately retires file context even without application event delivery", t => {
  const f = fixture(t);
  f.context.receive(event());
  f.context.receive({ method: "turn/completed", params: { threadId: identity.threadId, turn: { id: identity.turnId } } });
  assert.equal(f.preparer.prepare(fileRequest).kind, "unsupported");
  assert.throws(() => f.context.receive(event()));
});
