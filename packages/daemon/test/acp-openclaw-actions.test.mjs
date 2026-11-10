import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenClawActionPreparer } from "../dist/runtime/acp/openclaw-action-preparation.js";

const cwd = "/tmp/ling-openclaw-actions";
const policy = { toolDecisions: { bash: "ask", edit: "ask", write: "ask" }, allowedWritePaths: ["."] };

function request(overrides = {}) {
  const approvalId = overrides.approvalId ?? "approval-123";
  const toolCall = {
    toolCallId: overrides.toolCallId ?? "gateway-tool-call",
    title: "Command approval requested",
    kind: "execute",
    status: "pending",
    rawInput: { name: "exec", approvalId, command: "whois example.com", host: "gateway" },
    _meta: { toolName: "exec", approvalId },
    ...overrides.toolCall,
  };
  return {
    requestId: "request-1",
    params: {
      sessionId: "session-1",
      toolCall,
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      ...overrides.params,
    },
  };
}

function preparer(overrides = {}) {
  return new OpenClawActionPreparer({ sessionId: "session-1", cwd, policy, ...overrides });
}

test("OpenClaw prepares only the pinned Gateway exec approval and keeps the native approval identity", () => {
  const action = preparer().prepare(request({ toolCallId: "real-tool-call", approvalId: "approval-456" }));
  assert.equal(action.kind, "action");
  assert.equal(action.contextIdentity, "openclaw-exec:approval-456");
  assert.equal(action.contextCwd, cwd);
  assert.deepEqual(action.approval, {
    actionType: "bash",
    risk: "medium",
    toolCallId: "real-tool-call",
    title: "Approve shell command",
    description: "whois example.com",
    payload: { type: "bash", command: "whois example.com", cwd, riskFlags: [] },
    extraSecrets: undefined,
  });
  assert.equal(action.policyDecision.decision, "ask");
});

test("OpenClaw remote permission remains once-only when local Bash policy is allow", () => {
  const action = preparer({ policy: { ...policy, toolDecisions: { ...policy.toolDecisions, bash: "allow" } } }).prepare(request());
  assert.equal(action.kind, "action");
  assert.deepEqual(action.policyDecision, {
    decision: "ask",
    reason: "The native engine requires explicit approval for this action.",
  });
  assert.equal("proposedCommandRule" in action.approval, false);
});

test("OpenClaw retains local deny, Plan Mode, risk review and mandatory approval priority", () => {
  const denied = preparer({ policy: { ...policy, toolDecisions: { ...policy.toolDecisions, bash: "deny" } } }).prepare(request());
  assert.equal(denied.kind, "action");
  assert.equal(denied.policyDecision.decision, "deny");

  const plan = preparer({ effectivePolicySnapshot: { conversationMode: "plan" } }).prepare(request({
    toolCall: { rawInput: { name: "exec", approvalId: "approval-123", command: "touch output.txt", host: "gateway" } },
  }));
  assert.equal(plan.kind, "action");
  assert.equal(plan.policyDecision.decision, "deny");

  const risky = preparer({ policy: { ...policy, toolDecisions: { ...policy.toolDecisions, bash: "allow" } } }).prepare(request({
    toolCall: { rawInput: { name: "exec", approvalId: "approval-123", command: "rm -rf output", host: "gateway" } },
  }));
  assert.equal(risky.kind, "action");
  assert.equal(risky.policyDecision.decision, "ask");
  assert.equal(risky.approval.risk, "high");

  const mandatory = preparer({ approvalProfile: { mode: "strict" },
    policy: { ...policy, toolDecisions: { ...policy.toolDecisions, bash: "allow" } } }).prepare(request());
  assert.equal(mandatory.kind, "action");
  assert.equal(mandatory.policyDecision.decision, "ask");
  assert.match(mandatory.policyDecision.reason, /profile.*requires approval/);
});

test("OpenClaw rejects unbound sessions, non-pending execs and substituted approval identities", () => {
  const candidates = [
    request({ params: { sessionId: "other-session" } }),
    request({ toolCall: { kind: "read" } }),
    request({ toolCall: { status: "in_progress" } }),
    request({ toolCall: { rawInput: undefined } }),
    request({ toolCall: { rawInput: { name: "bash", approvalId: "approval-123", command: "whois example.com", host: "gateway" } } }),
    request({ toolCall: { rawInput: { name: "exec", approvalId: "other", command: "whois example.com", host: "gateway" } } }),
    request({ toolCall: { _meta: { toolName: "exec", approvalId: "other" } } }),
    request({ toolCall: { _meta: { toolName: "bash", approvalId: "approval-123" } } }),
    request({ toolCall: { _meta: undefined } }),
  ];
  for (const candidate of candidates) assert.equal(preparer().prepare(candidate).kind, "unsupported");
});

test("OpenClaw accepts only an explicit Gateway host and one bounded simple command", () => {
  const candidates = [
    { name: "exec", approvalId: "approval-123", command: "whois example.com" },
    { name: "exec", approvalId: "approval-123", command: "whois example.com", host: "node" },
    { name: "exec", approvalId: "approval-123", command: "whois example.com", host: "unknown" },
    { name: "exec", approvalId: "approval-123", command: "", host: "gateway" },
    { name: "exec", approvalId: "approval-123", command: "whois example.com\nwhoami", host: "gateway" },
    { name: "exec", approvalId: "approval-123", command: "whois example.com | cat", host: "gateway" },
    { name: "exec", approvalId: "approval-123", command: "x".repeat(4097), host: "gateway" },
    { name: "exec", approvalId: "a".repeat(257), command: "whois example.com", host: "gateway" },
  ];
  for (const rawInput of candidates) {
    const approvalId = rawInput.approvalId;
    const candidate = request({ approvalId, toolCall: { rawInput, _meta: { toolName: "exec", approvalId } } });
    assert.equal(preparer().prepare(candidate).kind, "unsupported");
  }
});

test("OpenClaw validates the exact once/always/deny option mapping without requiring a synthetic tool id", () => {
  assert.equal(preparer().prepare(request({ toolCallId: "gateway-emitted-id" })).kind, "action");
  const validWithoutAlways = request({ params: { options: [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ] } });
  assert.equal(preparer().prepare(validWithoutAlways).kind, "action");
  const invalid = [
    [],
    [{ optionId: "allow-once", name: "Once", kind: "allow_once" }],
    [{ optionId: "deny", name: "Deny", kind: "reject_once" }],
    [{ optionId: "allow_once", name: "Once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    [{ optionId: "allow-once", name: "Once", kind: "allow_once" }, { optionId: "reject", name: "Deny", kind: "reject_once" }],
    [{ optionId: "allow-once", name: "Once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" },
      { optionId: "deny-always", name: "Never", kind: "reject_always" }],
    [{ optionId: "allow-once", name: "Once", kind: "allow_once" }, { optionId: "allow-once", name: "Again", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" }],
  ];
  for (const options of invalid) assert.equal(preparer().prepare(request({ params: { options } })).kind, "unsupported");
});

test("OpenClaw preparation snapshots caller-owned values and rejects foreign updates", () => {
  const config = { sessionId: "session-1", cwd, policy };
  const actions = new OpenClawActionPreparer(config);
  config.sessionId = "mutated";
  assert.equal(actions.prepare(request()).kind, "action");
  assert.throws(() => actions.receive({ sessionId: "foreign", update: { sessionUpdate: "tool_call" } }), { code: "binding_mismatch" });
  actions.receive({ sessionId: "session-1", update: { sessionUpdate: "tool_call" } });
  actions.clear();
});
