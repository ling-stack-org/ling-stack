import assert from "node:assert/strict";
import test from "node:test";
import { companionAttentionSourceKey, isCompanionAttentionPending, orderCompanionAttentionItems, type CompanionAttentionItem } from "../src/companion-attention.ts";

function item(overrides: Partial<CompanionAttentionItem> = {}): CompanionAttentionItem {
  return {
    schemaVersion: 1,
    id: "approval:one",
    priority: "approval",
    status: "pending",
    source: { workspaceId: "workspace", cwd: "/workspace", kind: "approval", id: "one", approvalId: "one" },
    title: "Review",
    summary: "Review a change",
    revision: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    payload: { kind: "approval", approvalId: "one", status: "pending", risk: "medium" },
    ...overrides,
  };
}

test("attention source keys are stable across presentation changes", () => {
  assert.equal(companionAttentionSourceKey({ workspaceId: "w", cwd: "/w", kind: "approval", id: "a" }), "approval:a");
  assert.equal(isCompanionAttentionPending(item()), true);
  assert.equal(isCompanionAttentionPending(item({ status: "resolved" })), false);
});

test("attention queue deduplicates source replays and prioritizes actionable work", () => {
  const stale = item({ revision: 1, updatedAt: "2026-11-20T00:00:00.000Z" });
  const current = item({ revision: 2, updatedAt: "2026-11-20T00:01:00.000Z", summary: "Current" });
  const question = item({
    id: "user_input:req",
    priority: "required_input",
    source: { workspaceId: "workspace", cwd: "/workspace", kind: "user_input", id: "req", requestId: "req" },
    payload: { kind: "user_input", requestId: "req", requestVersion: 1, statusRevision: 1, status: "pending", waitMode: "required", questions: [] },
  });
  const resolvedBrief = item({ id: "terminal_report:report", priority: "result", status: "resolved", source: { workspaceId: "workspace", cwd: "/workspace", kind: "terminal_report", id: "report", reportId: "report" }, payload: { kind: "terminal_report", reportId: "report", outcomeStatus: "succeeded" } });
  assert.deepEqual(orderCompanionAttentionItems([resolvedBrief, stale, question, current]).map((entry) => entry.id), ["user_input:req", "approval:one", "terminal_report:report"]);
  assert.equal(orderCompanionAttentionItems([stale, current])[0]?.summary, "Current");
});
