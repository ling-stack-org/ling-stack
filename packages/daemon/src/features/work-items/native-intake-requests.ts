import { LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT, type ListNativeWorkIntakeRequest, type ListNativeWorkIntakeResponse,
  type NativeWorkIntakeMutationResponse } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { acceptAutomationIntakeSuggestion } from "../automations/native-intake.js";
import type { NativeWorkIntake } from "./native-intake.js";

export function readNativeWorkIntakeListRequest(input: Record<string, unknown>, maxLimit: number): ListNativeWorkIntakeRequest {
  const { sourceKind, sourceScope, limit = LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT } = input;
  if (sourceKind !== "channel_task" && sourceKind !== "automation_run"
    || sourceScope !== undefined && (typeof sourceScope !== "string" || !sourceScope.trim() || sourceScope.length > 200)
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
    throw new HttpError(400, "invalid_params", "Supply an intake source kind and optional source scope and result limit.");
  }
  return { sourceKind, sourceScope, limit: Math.min(limit, maxLimit) };
}

export function listNativeWorkIntake(store: RunStore, input: ListNativeWorkIntakeRequest): ListNativeWorkIntakeResponse {
  return { cwd: store.paths.cwd, receipts: store.listNativeWorkIntakeReceipts(input.sourceKind, input.sourceScope, input.limit ?? LING_APP_SERVER_NATIVE_INTAKE_PAGE_LIMIT) };
}

type NativeIntakeMutation = { action: "accept"; receiptId: string } | { action: "retry"; receiptId: string; idempotencyKey: string };

export function readNativeWorkIntakeMutation(action: NativeIntakeMutation["action"], input: Record<string, unknown>): NativeIntakeMutation {
  const { receiptId, idempotencyKey } = input;
  if (typeof receiptId !== "string" || !/^intake_[a-f0-9]{64}$/u.test(receiptId)) {
    throw new HttpError(400, "invalid_params", "Supply a native intake receipt ID.");
  }
  if (action === "retry") {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200) {
      throw new HttpError(400, "invalid_params", "Supply a bounded idempotency key to re-evaluate the receipt.");
    }
    return { action, receiptId, idempotencyKey };
  }
  return { action, receiptId };
}

export function mutateNativeWorkIntake(store: RunStore, intake: NativeWorkIntake, input: NativeIntakeMutation): NativeWorkIntakeMutationResponse {
  if (input.action === "retry") return { cwd: store.paths.cwd, receipt: intake.retry(store, input) };
  const { receiptId } = input;
  const receipt = intake.read(store, receiptId)?.receipt;
  if (receipt?.outcome !== "suggested") throw new HttpError(404, "native_intake_unavailable", "The intake suggestion is unavailable.");
  if (receipt.dispatch) return { cwd: store.paths.cwd, receipt };
  if (receipt.sourceKind === "channel_task") return { cwd: store.paths.cwd, receipt: intake.acceptTaskSuggestion(store, receipt) };
  const automation = store.getAutomationDefinition(receipt.sourceScope);
  if (!automation) throw new HttpError(404, "native_intake_unavailable", "The Automation is unavailable.");
  return { cwd: store.paths.cwd, receipt: acceptAutomationIntakeSuggestion(store, intake, automation, receiptId).intakeReceipt };
}
