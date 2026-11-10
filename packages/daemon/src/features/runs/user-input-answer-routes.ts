import type { IncomingMessage, ServerResponse } from "node:http";
import { UserInputStoreError, type RunStore, type UserInputAnswerReceipt } from "@ling-stack/core";
import type { UserInputAnswerSubmissionResponseV1 } from "@ling-stack/contracts";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";

export async function handleUserInputAnswerSubmission(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  maxBodyBytes: number,
  route: { readonly threadId: string; readonly requestId: string },
  onAccepted?: (store: RunStore) => void,
): Promise<void> {
  const cwd = url.searchParams.get("cwd") ?? undefined;
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return;
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for user input answer submission`,
    });
    return;
  }

  try {
    const submission = await readSubmissionBody(request, maxBodyBytes);
    if (!isRecord(submission) || submission.requestId !== route.requestId) {
      throw new UserInputStoreError("invalid_input");
    }
    const store = storeRegistry.getStore(cwd);
    const receipt = store.submitUserInputAnswer({
      threadId: route.threadId,
      submission,
    }, new Date().toISOString());
    writeJson(response, receipt.replayed ? 200 : 201, projectReceipt(receipt));
    onAccepted?.(store);
  } catch (error) {
    writeSubmissionError(response, error);
  }
}

function projectReceipt(receipt: UserInputAnswerReceipt): UserInputAnswerSubmissionResponseV1 {
  return {
    requestId: receipt.requestId,
    requestVersion: receipt.requestVersion,
    answerId: receipt.answerId,
    answerItemId: receipt.answerItemId,
    deliveryId: receipt.deliveryId,
    acceptedAt: receipt.acceptedAt,
    replayed: receipt.replayed,
  };
}

function writeSubmissionError(response: ServerResponse, error: unknown): void {
  if (error instanceof UserInputAnswerBodyError) {
    writeJson(response, 400, { error: "invalid_user_input_answer", message: "The answer submission is invalid." });
    return;
  }
  if (!(error instanceof UserInputStoreError)) {
    writeJson(response, 500, { error: "internal_error", message: "The answer could not be submitted." });
    return;
  }
  if (error.code === "not_found") {
    writeJson(response, 404, {
      error: "user_input_request_not_found",
      message: "The user input request was not found in this thread.",
    });
    return;
  }
  if (["invalid_input", "invalid_request", "unknown_question", "unknown_option", "free_text_not_allowed",
    "missing_required_answer", "sensitive_input"].includes(error.code)) {
    writeJson(response, 400, { error: "invalid_user_input_answer", message: "The answer submission is invalid." });
    return;
  }
  writeJson(response, 409, {
    error: "user_input_answer_conflict",
    message: "The question changed or is no longer accepting answers.",
  });
}

class UserInputAnswerBodyError extends Error {}

async function readSubmissionBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  try {
    return await readJsonBody(request, maxBodyBytes);
  } catch {
    throw new UserInputAnswerBodyError();
  }
}
