import { isHostCapabilityToolNameV1, readHostCapabilityCallV1 } from "@ling-stack/contracts";
import type { ApprovalPayload } from "@ling-stack/core";
import type { PiRunnerApprovalRequest } from "@ling-stack/runner-pi";
import type { ClassifiedAction } from "./action-classifier.js";

/** Typed Host calls never inherit the unknown-tool MCP fallback or Bash permissions. */
export function hostCapabilityApprovalPayload(request: Pick<PiRunnerApprovalRequest, "toolName" | "input" | "cwd">):
  Extract<ApprovalPayload, { type: "host_capability" }> | undefined {
  if (!isHostCapabilityToolNameV1(request.toolName)) {
    if (request.toolName.startsWith("host_")) throw new Error("Unsupported reserved Host capability tool.");
    return undefined;
  }
  return { type: "host_capability", cwd: request.cwd, ...readHostCapabilityCallV1(request.toolName, request.input) };
}

export function classifyHostCapabilityAction(payload: Extract<ApprovalPayload, { type: "host_capability" }>): ClassifiedAction {
  const open = payload.capabilityId === "host.open_local_target";
  return {
    actionType: "host_capability", risk: "medium", scopes: open ? ["external_system"] : ["read_only"],
    scopeSummary: open ? "Display local file through Host" : "Read local interface addresses through Host",
    title: open ? "Open local file" : "Read local network information",
    summary: open ? payload.input.path : `${payload.input.family}; loopback=${payload.input.includeLoopback}`,
    targetRefs: [{ type: "host_capability", id: payload.capabilityId, label: payload.capabilityId },
      ...(open ? [{ type: "file" as const, path: payload.input.path, label: payload.input.path }] : [])],
  };
}

/** Invalid model input must be visible as an invalid tool attempt, not crash event projection. */
export function classifyHostCapabilityToolAction(request: Pick<PiRunnerApprovalRequest, "toolName" | "input" | "cwd">): ClassifiedAction | undefined {
  try {
    const payload = hostCapabilityApprovalPayload(request);
    return payload ? classifyHostCapabilityAction(payload) : undefined;
  } catch {
    return { actionType: "host_capability", risk: "medium", scopes: ["external_system"], scopeSummary: "Invalid Host capability input",
      title: "Host capability", summary: "Invalid or unsupported Host capability request", targetRefs: [] };
  }
}
