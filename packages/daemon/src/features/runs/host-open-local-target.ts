import { extname } from "node:path";
import {
  readHostCapabilityCallV1,
  type HostLocalTargetPresentationV1,
  type HostOpenLocalTargetReceiptV1,
} from "@ling-stack/contracts";
import type { RunSession } from "@ling-stack/core";
import type { PiRunnerHostCapabilityCallRequest, PiRunnerToolHandledResult } from "@ling-stack/runner-pi";
import { resolveWorkspaceFileTarget } from "../previews/workspace-file-preview.js";
import type { HostCapabilityBridgeController } from "./host-capability-bridge-controller.js";
import type { ReturnTypeOfHostCapabilityAuthority } from "./host-capability-authority.js";

export async function dispatchHostOpenLocalTarget(input: {
  readonly bridge: HostCapabilityBridgeController;
  readonly authority: ReturnTypeOfHostCapabilityAuthority;
  readonly run: RunSession;
  readonly request: PiRunnerHostCapabilityCallRequest;
}): Promise<PiRunnerToolHandledResult> {
  const rejection = input.authority.check(input.request, input.request.approvalId);
  if (rejection) return failure(rejection.code, rejection.reason);
  let call;
  try {
    call = readHostCapabilityCallV1(input.request.toolName, input.request.input);
  } catch {
    return failure("host_capability_input_invalid", "Invalid Host open input.");
  }
  if (call.capabilityId !== "host.open_local_target") {
    return failure("host_capability_unsupported", "Unsupported Host capability.");
  }
  try {
    const target = resolveWorkspaceFileTarget(input.run.cwd, call.input.path);
    const receipt = await input.bridge.executeOpenLocalTarget({
      path: target.displayPath,
      absolutePath: target.contentPath,
      workspaceRoot: input.run.cwd,
      presentation: presentationForPath(target.contentPath),
      runId: input.request.runId,
      attemptId: input.request.attemptId,
      toolCallId: input.request.toolCallId,
      approvalId: input.request.approvalId,
      idempotencyKey: [input.request.runId, input.request.attemptId, input.request.toolCallId,
        input.request.approvalId, call.input.path].join(":"),
      signal: input.request.signal,
    });
    const after = input.authority.check(input.request, input.request.approvalId);
    if (after) return failure(after.code, after.reason);
    return hostOpenLocalTargetToolResult(receipt);
  } catch (error) {
    input.request.signal.throwIfAborted();
    return failure(safeCode(error), "The Ling Host could not display this workspace file.");
  }
}

export function hostOpenLocalTargetToolResult(receipt: HostOpenLocalTargetReceiptV1): PiRunnerToolHandledResult {
  return {
    isError: false,
    content: [{ type: "text", text: `Ling Host accepted the local preview for ${JSON.stringify(receipt.path)}. Window visibility is unverified.` }],
    details: { hostCapabilityResult: receipt },
  };
}

export function presentationForPath(path: string): HostLocalTargetPresentationV1 {
  const extension = extname(path).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "interactive_html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(extension)) return "image";
  return "read_only_text";
}

function failure(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { code } };
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,96}$/iu.test(value) ? value : "host_capability_failed";
}
