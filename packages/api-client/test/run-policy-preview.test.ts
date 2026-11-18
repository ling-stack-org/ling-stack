import assert from "node:assert/strict";
import test from "node:test";
import type { RunPolicyPreviewRequest, RunPolicyPreviewResponse } from "@ling-stack/contracts";
import { LingDaemonClient } from "../dist/index.js";

test("policy preview client posts the scoped request without adding execution fields", async () => {
  const request: RunPolicyPreviewRequest = {
    channelId: "channel/one",
    taskId: "task one",
    permissionPreset: "workspace_collaboration",
    approvalProfile: { mode: "strict", requiredForTools: ["bash"] },
  };
  const response: RunPolicyPreviewResponse = {
    permissionPreset: "workspace_collaboration",
    permissionMode: "workspace_write",
    effectivePolicySnapshot: {
      mode: "workspace_write",
      toolDecisions: { read: "allow", grep: "allow", find: "allow", ls: "allow", bash: "ask", edit: "allow", write: "allow" },
      allowedWritePaths: ["/workspace/project"],
      workspacePolicyUpdatedAt: "2026-11-18T00:00:00.000Z",
      riskNotes: [],
    },
    requiresConfirmation: false,
  };
  const calls: { readonly url: URL; readonly init?: RequestInit }[] = [];
  const client = new LingDaemonClient({
    baseUrl: "http://daemon.test",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json(response);
    },
  });

  assert.deepEqual(await client.previewRunPolicy("/workspace root", request), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url.pathname, "/runs/policy-preview");
  assert.equal(calls[0]!.url.searchParams.get("cwd"), "/workspace root");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), request);
});
