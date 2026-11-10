import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateApprovalActionPolicy,
  evaluateApprovalPolicy,
  classifyApprovalRisk,
} from "../dist/features/runs/approval-action-policy.js";

const cwd = "/tmp/ling-action-policy";
const request = { toolName: "bash", cwd };
const payload = { type: "bash", cwd, command: "whois example.com", riskFlags: [] };
const approvalInput = { toolCallId: "call-1", actionType: "bash", risk: "medium",
  title: "Approve shell command", description: payload.command, payload };
const policy = { toolDecisions: { bash: "ask", edit: "ask", write: "ask" }, allowedWritePaths: ["."] };
const evaluate = (overrides = {}) => evaluateApprovalActionPolicy({ policy, request, approvalInput, ...overrides });

test("only an ordinary Bash ask is eligible for workspace command rules", () => {
  assert.equal(evaluate().commandRuleEligible, true);
  for (const decision of ["allow", "deny"]) {
    const result = evaluate({ policy: { ...policy, toolDecisions: { bash: decision } } });
    assert.equal(result.policyDecision.decision, decision);
    assert.equal(result.commandRuleEligible, false);
    assert.equal(result.approvalInput, approvalInput);
  }
});

for (const profile of [
  { mode: "strict" },
  { mode: "standard", requiredForTools: ["bash"] },
  { mode: "standard", requiredForActions: ["git_commit"] },
]) test(`profile ${JSON.stringify(profile)} requires review even with bash=allow`, () => {
  const input = { ...approvalInput, actionType: "git_commit", payload: { ...payload, command: "git commit -m fixture" } };
  const result = evaluate({ approvalInput: input, policy: { ...policy, toolDecisions: { bash: "allow" } }, approvalProfile: profile });
  assert.equal(result.policyDecision.decision, "ask");
  assert.match(result.policyDecision.reason, /profile.*requires approval/);
  assert.equal(result.commandRuleEligible, false);
  assert.equal(evaluate({ approvalInput: input, approvalProfile: profile }).commandRuleEligible, false);
  assert.equal(evaluate({ approvalInput: input, approvalProfile: profile,
    policy: { ...policy, toolDecisions: { bash: "deny" } } }).policyDecision.decision, "deny");
});

test("inactive and unrelated profiles retain ordinary tool policy", () => {
  for (const approvalProfile of [{ mode: "none", requiredForTools: ["bash"] }, { mode: "standard", requiredForActions: ["edit"] }]) {
    assert.equal(evaluate({ approvalProfile }).commandRuleEligible, true);
  }
});

test("risk-required asks cannot be bypassed through command rules", () => {
  for (const [command, riskFlags, risk] of [
    ["rm -rf output", ["destructive_remove"], "high"],
    ["git push --force origin main", ["git_force_push"], "critical"],
    ["security find-generic-password", [], "medium"],
  ]) {
    const input = { ...approvalInput, risk, payload: { ...payload, command, riskFlags } };
    const result = evaluate({ approvalInput: input, policy: { ...policy, toolDecisions: { bash: "allow" } } });
    assert.equal(result.policyDecision.decision, "ask");
    assert.equal(result.commandRuleEligible, false);
    assert.match(result.approvalInput.title, /^Risk review required:/);
    assert.equal(evaluate({ approvalInput: input }).commandRuleEligible, false);
    assert.equal(evaluate({ approvalInput: input, policy: { ...policy, toolDecisions: { bash: "deny" } } }).policyDecision.decision, "deny");
  }
});

test("high-risk actions without a risk-review trigger still cannot reuse command rules", () => {
  assert.equal(evaluate({ approvalInput: { ...approvalInput, risk: "high" } }).commandRuleEligible, false);
});

test("Plan Mode denies mutation despite tool allow and required approval", () => {
  const result = evaluate({ approvalInput: { ...approvalInput, payload: { ...payload, command: "touch output.txt" } },
    effectivePolicySnapshot: { conversationMode: "plan" }, approvalProfile: { mode: "strict" },
    policy: { ...policy, toolDecisions: { bash: "allow" } } });
  assert.equal(result.policyDecision.decision, "deny");
  assert.match(result.policyDecision.reason, /^Plan Mode/);
  assert.equal(result.commandRuleEligible, false);
  assert.equal(evaluate({ effectivePolicySnapshot: { conversationMode: "plan" },
    approvalInput: { ...approvalInput, payload: { ...payload, command: "git status" } } }).policyDecision.decision, "ask");
});

test("every touched path including move destinations must be inside allowed writes", () => {
  const file = { type: "file_edit", path: "source.txt", touchedPaths: ["source.txt", "../outside.txt"], diffPreview: "fixture" };
  const result = evaluate({ request: { toolName: "edit", cwd }, approvalInput: { ...approvalInput, actionType: "edit", payload: file },
    policy: { ...policy, toolDecisions: { edit: "allow" } } });
  assert.equal(result.policyDecision.decision, "deny");
  assert.equal(result.commandRuleEligible, false);
  assert.equal(classifyApprovalRisk({ toolName: "edit", cwd }, file), "high");
  assert.equal(evaluateApprovalPolicy(policy, { toolName: "edit", cwd }, { ...file, touchedPaths: ["source.txt", "dest.txt"] }).decision, "ask");
  assert.equal(evaluateApprovalPolicy(policy, { toolName: "edit", cwd }, { ...file, path: "<unknown>", touchedPaths: [] }).decision, "deny");
  assert.equal(evaluateApprovalPolicy({ ...policy, allowedWritePaths: [] }, { toolName: "edit", cwd }, file).decision, "deny");
});

test("read-only and MCP defaults retain existing tool decisions", () => {
  const read = { type: "tool_call", toolName: "read", cwd, input: { path: "README.md" } };
  assert.equal(evaluateApprovalPolicy(policy, { toolName: "read", cwd }, read).decision, "allow");
  assert.equal(classifyApprovalRisk({ toolName: "read", cwd }, read), "low");
  const mcp = { type: "mcp_tool_call", toolName: "mcp-fixture", cwd, input: {} };
  assert.equal(evaluateApprovalPolicy(policy, { toolName: "mcp-fixture", cwd }, mcp).decision, "ask");
  assert.equal(evaluateApprovalPolicy(policy, { toolName: "mcp-fixture", cwd, defaultApproval: "deny" }, mcp).decision, "deny");
});

test("evaluating a frozen input never rewrites policy or approval data", () => {
  const input = Object.freeze({ ...approvalInput, risk: "critical" });
  const result = evaluate({ approvalInput: input, policy: Object.freeze(policy) });
  assert.equal(input.title, "Approve shell command");
  assert.match(result.approvalInput.title, /^Risk review required:/);
  assert.equal(classifyApprovalRisk(request, { ...payload, riskFlags: ["git_force_push"] }), "critical");
});
