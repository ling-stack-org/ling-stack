import type { Page } from "@playwright/test";
import { cwd, type MockApproval, type MockState } from "./mock-state";

export interface ApprovalsFaultFixture {
  failNextList?: boolean;
  wrongCwdNextList?: boolean;
  listDelayMs?: number;
  decisionDelayMs?: number;
  expireOnNextDecisionId?: string;
  failNextDecisionId?: string;
  readonly externalDetailFailureIds: Set<string>;
  failNextExternalExecuteId?: string;
  failNextExternalCancelId?: string;
  readonly decisionCalls: Map<string, number>;
}

export function createApprovalsFaultFixture(): ApprovalsFaultFixture {
  return { decisionCalls: new Map(), externalDetailFailureIds: new Set() };
}

export async function installApprovalsFaults(
  page: Page,
  state: MockState,
  fixture: ApprovalsFaultFixture,
): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/approvals") {
      if (fixture.failNextList) {
        fixture.failNextList = false;
        await route.fulfill({ status: 503, json: { error: "approval_refresh_unavailable", message: "Synthetic approval refresh failure" } });
        return;
      }
      if (fixture.wrongCwdNextList) {
        fixture.wrongCwdNextList = false;
        await route.fulfill({ json: { cwd: "/tmp/stale-approval-workspace", approvals: [createApproval({ id: "approval_stale", title: "Stale workspace approval" })] } });
        return;
      }
      if (fixture.listDelayMs) await delay(fixture.listDelayMs);
      await route.fallback();
      return;
    }
    const decisionMatch = /^\/approvals\/([^/]+)\/(approve|deny)$/u.exec(path);
    if (request.method() === "POST" && decisionMatch) {
      const approvalId = decodeURIComponent(decisionMatch[1]);
      fixture.decisionCalls.set(approvalId, (fixture.decisionCalls.get(approvalId) ?? 0) + 1);
      if (fixture.failNextDecisionId === approvalId) {
        fixture.failNextDecisionId = undefined;
        await route.fulfill({ status: 503, json: { error: "approval_decision_unavailable", message: "Synthetic approval decision failure" } });
        return;
      }
      if (fixture.expireOnNextDecisionId === approvalId) {
        fixture.expireOnNextDecisionId = undefined;
        const approval = state.approvals.find((item) => item.id === approvalId);
        if (approval) {
          approval.status = "expired";
          approval.expiresAt = "2000-01-01T00:00:00.000Z";
          approval.resolvedAt = "2026-07-22T01:30:00.000Z";
          approval.decisionReason = "Expired before the decision reached authority.";
        }
        await route.fulfill({ status: 409, json: { error: "approval_not_pending", message: "Approval request expired." } });
        return;
      }
      if (fixture.decisionDelayMs) await delay(fixture.decisionDelayMs);
      await route.fallback();
      return;
    }
    const actionDetailMatch = /^\/external-work\/actions\/([^/]+)$/u.exec(path);
    if (request.method() === "GET" && actionDetailMatch && fixture.externalDetailFailureIds.has(decodeURIComponent(actionDetailMatch[1]))) {
      await route.fulfill({ status: 503, json: { error: "external_detail_unavailable", message: "Synthetic external detail failure" } });
      return;
    }
    const actionMutationMatch = /^\/external-work\/actions\/([^/]+)\/(execute|cancel)$/u.exec(path);
    if (request.method() === "POST" && actionMutationMatch) {
      const actionId = decodeURIComponent(actionMutationMatch[1]);
      const operation = actionMutationMatch[2];
      if (operation === "execute" && fixture.failNextExternalExecuteId === actionId) {
        fixture.failNextExternalExecuteId = undefined;
        await route.fulfill({ status: 503, json: { error: "external_execute_unavailable", message: "Synthetic external execute failure" } });
        return;
      }
      if (operation === "cancel" && fixture.failNextExternalCancelId === actionId) {
        fixture.failNextExternalCancelId = undefined;
        await route.fulfill({ status: 503, json: { error: "external_cancel_unavailable", message: "Synthetic external cancel failure" } });
        return;
      }
    }
    await route.fallback();
  });
}

export function createApproval(overrides: Partial<MockApproval> = {}): MockApproval {
  return {
    id: overrides.id ?? "approval_fixture",
    actionType: overrides.actionType ?? "credential_change",
    risk: overrides.risk ?? "medium",
    title: overrides.title ?? "Review fixture approval",
    description: overrides.description ?? "Review the requested operation and its consequence.",
    payload: overrides.payload ?? { type: "credential_change", target: "workspace" },
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2026-07-22T01:00:00.000Z",
    expiresAt: overrides.expiresAt ?? ((overrides.status ?? "pending") === "pending" ? "2099-01-01T00:00:00.000Z" : undefined),
    ...overrides,
  };
}

export function createPermissionApproval(overrides: Partial<MockApproval> = {}): MockApproval {
  return createApproval({
    id: "approval_permission_delta",
    channelId: "channel_offline",
    actionType: "runtime_permission_request",
    risk: "high",
    title: "Expand runtime write scope",
    description: "Allow the run to edit the release workspace.",
    payload: {
      type: "runtime_permission_request",
      requestKind: "core_tool",
      reason: "Release repair needs one additional editor tool.",
      currentScope: { kind: "core_tool", tools: ["read", "bash"] },
      requestedScope: { kind: "core_tool", tools: ["bash", "edit"] },
      proposedContinuation: { mode: "resume" },
    },
    ...overrides,
  });
}

export function createHundredApprovals(): MockApproval[] {
  return Array.from({ length: 100 }, (_, index) => createApproval({
    id: `approval_${String(index + 1).padStart(3, "0")}`,
    channelId: "channel_offline",
    actionType: index % 2 === 0 ? "credential_change" : "provider_change",
    risk: index % 9 === 0 ? "high" : index % 3 === 0 ? "medium" : "low",
    title: `Approval ${String(index + 1).padStart(3, "0")}`,
    description: `Review fixture operation ${index + 1}`,
    createdAt: new Date(Date.parse("2026-07-22T01:00:00.000Z") + index * 1_000).toISOString(),
  }));
}

export function createLongExpiredApproval(): MockApproval {
  const longPath = `${cwd}/${"very-long-workspace-segment/".repeat(8)}release-notes-and-migration-plan.md`;
  return createApproval({
    id: "approval_expired_long",
    runId: "run_inspect",
    actionType: "edit",
    risk: "critical",
    title: "Expired long-path file mutation",
    description: `The request expired before this deeply nested file could be changed: ${longPath}`,
    payload: {
      type: "file_edit",
      path: longPath,
      touchedPaths: [longPath],
      patchFormat: "unified",
      diffPreview: `--- ${longPath}\n+++ ${longPath}\n@@ -1 +1 @@\n-${"old ".repeat(100)}\n+${"new ".repeat(100)}`,
      audit: { nested: { target: longPath, policySnapshot: "read-only-until-approved" } },
    },
    status: "expired",
    expiresAt: "2000-01-01T00:00:00.000Z",
    resolvedAt: "2026-07-22T01:05:00.000Z",
    decisionReason: "Approval request expired before a decision was received.",
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
