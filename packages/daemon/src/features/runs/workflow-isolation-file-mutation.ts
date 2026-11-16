import { isDeepStrictEqual } from "node:util";
import type { PiRunnerIsolatedToolCallRequest } from "@ling-stack/runner-pi";
import { isRecord } from "../../shared/validation.js";
import type { FileMutationActionDraft } from "../harness/tool-execution/executors/file-mutation.js";
import { assertPatchPathsWithinAllowedWritePaths, type PatchActionApplyOutput } from "./patch-actions.js";
import { assertWorkflowIsolationFileAuthority, type WorkflowIsolationFileAuthorityInput } from "./workflow-isolation-file-authority.js";
import { executeWorkflowIsolatedTool } from "./workflow-isolated-executor.js";

/** Only the bounded Host writer may implement this single-file approved effect. No raw patch or rollback fallback. */
export async function applyWorkflowIsolationFileMutation(input: WorkflowIsolationFileAuthorityInput & {
  readonly draft: FileMutationActionDraft;
  readonly allowedWritePaths: readonly string[];
  readonly previewArtifactIds?: readonly string[];
}): Promise<PatchActionApplyOutput> {
  const captured = assertWorkflowIsolationFileAuthority(input);
  const draft = structuredClone(input.draft), request = { ...input.request, input: structuredClone(input.request.input) };
  const operation = draft.plan.operations[0];
  if (draft.executorKind !== "write" || draft.plan.operations.length !== 1 || draft.plan.touchedPaths.length !== 1
    || !operation || !["add", "update"].includes(operation.kind) || !isRecord(request.input)
    || operation.path !== request.input.path || draft.plan.touchedPaths[0] !== operation.path
    || typeof operation.newSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(operation.newSha256)
    || (operation.kind === "add" ? operation.oldSha256 !== undefined
      : typeof operation.oldSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(operation.oldSha256))) {
    throw new Error("workflow_isolation_file_preview_invalid");
  }
  const assertCurrent = (): void => {
    const current = assertWorkflowIsolationFileAuthority(input);
    if (!isDeepStrictEqual(current, captured)) throw new Error("workflow_isolation_file_authority_changed");
    assertPatchPathsWithinAllowedWritePaths(draft.plan.touchedPaths, request.cwd, input.allowedWritePaths);
  };
  assertCurrent();
  const handled = await executeWorkflowIsolatedTool({ root: captured.root,
    request: { toolName: request.toolName, toolCallId: request.toolCallId, cwd: request.cwd, input: request.input,
      signal: input.signal } as PiRunnerIsolatedToolCallRequest,
    assertCurrent, hostWrite: { effectGuard: input.hostOperation!.effectGuard },
    expectedMutation: { oldSha256: operation.oldSha256, newSha256: operation.newSha256 } });
  // Unknown effects throw through to the Broker. Never infer no-start or attempt a raw rollback.
  const outcome = handled.isError === true ? "not_applied" : "applied";
  const details = { ...(isRecord(handled.details) ? handled.details : {}), status: outcome === "applied" ? "applied" : "failed",
    outcome, format: draft.plan.format, touchedPaths: draft.plan.touchedPaths, summary: draft.plan.summary };
  return { handledResult: { ...handled, details }, outcome,
    evidenceArtifactIds: [...new Set([...(input.previewArtifactIds ?? []), captured.artifact.id])],
    resultArtifactContent: `${JSON.stringify({ schemaVersion: 1, kind: "workflow_isolation_file_mutation", ...details,
      bindingId: captured.binding.bindingId, planId: captured.plan.planId, planDigest: captured.plan.planDigest,
      sourceFence: input.sourceFence, creationReceiptId: captured.receipt.receiptId,
      creationArtifactId: captured.artifact.id, rawPatchSha256: draft.plan.rawPatchSha256,
      expectedMutation: { oldSha256: operation.oldSha256, newSha256: operation.newSha256 },
      executorResult: handled, previewArtifactIds: input.previewArtifactIds ?? [] }, null, 2)}\n` };
}
