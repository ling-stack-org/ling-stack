import type { IncomingMessage, ServerResponse } from "node:http";
import { parseUserInputAnswerCommandV1, type UserInputAnswerAcceptedResponseV1 } from "@ling-stack/contracts";
import { UserInputStoreError, type RunStore } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

export type UserInputAnswerAcceptedHook = (store: RunStore) => void;

/** Public local-user answer boundary. Acceptance is durable Host evidence, not a Runner ACK. */
export async function handleUserInputAnswer(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  onDeliveryAccepted?: UserInputAnswerAcceptedHook,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Only POST is supported for user input answers." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required." });
    return;
  }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return;
  try {
    const parsed = parseUserInputAnswerCommandV1(await readJsonBody(request, config.maxBodyBytes));
    if (!parsed.ok) {
      writeJson(response, 400, { error: "invalid_user_input_answer", message: "The answer request is invalid." });
      return;
    }
    const command = parsed.value;
    const store = storeRegistry.getStore(cwd);
    const receipt = store.submitUserInputAnswer({
      threadId: command.authority.threadId,
      authority: command.authority,
      submission: {
        schemaVersion: 1,
        requestId: command.authority.requestId,
        expectedVersion: command.authority.requestVersion,
        expectedStatusRevision: command.authority.statusRevision,
        idempotencyKey: command.idempotencyKey,
        answers: command.answers,
      },
    }, new Date().toISOString());
    try {
      onDeliveryAccepted?.(store);
    } catch {
      // Durable outbox scanning owns correctness. The wake-up hook only lowers
      // latency and must never turn an accepted answer into a false HTTP error.
    }
    const body: UserInputAnswerAcceptedResponseV1 = {
      accepted: true,
      receipt,
      delivery: { status: "pending" },
    };
    writeJson(response, 202, body);
  } catch (error) {
    if (error instanceof UserInputStoreError) {
      const statusCode = error.code === "not_found" ? 404
        : ["stale_request", "request_not_pending", "request_expired", "source_conflict", "idempotency_conflict",
            "invalid_record", "wait_conflict"].includes(error.code) ? 409 : 400;
      writeJson(response, statusCode, {
        error: "user_input_answer_rejected",
        message: "The answer could not be accepted for the current question.",
      });
      return;
    }
    if (error instanceof Error && /Request body|valid JSON/u.test(error.message)) {
      writeJson(response, 400, { error: "invalid_user_input_answer", message: "The answer request is invalid." });
      return;
    }
    writeJson(response, 500, { error: "user_input_answer_failed", message: "The answer could not be saved." });
  }
}
