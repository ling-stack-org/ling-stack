import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";

import { isRecord } from "../../shared/validation.js";
import { HttpError } from "../../errors.js";
import type { NativeWorkIntake } from "./native-intake.js";

export async function handleNativeWorkIntakeCollection(
  request: IncomingMessage, response: ServerResponse, url: URL, stores: RunStoreRegistry,
  nativeIntake: NativeWorkIntake | undefined, maxBodyBytes: number,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Read or re-evaluate native intake receipts." });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (cwd && request.method === "POST" && nativeIntake) {
    try {
      const input = await readJsonBody(request, maxBodyBytes);
      if (!isRecord(input) || typeof input.receiptId !== "string" || !/^intake_[a-f0-9]{64}$/u.test(input.receiptId)
        || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
        writeJson(response, 400, { error: "bad_request", message: "A native intake receipt and bounded idempotency key are required." });
        return;
      }
      const store = stores.getStore(cwd);
      const receipt = nativeIntake.retry(store, { receiptId: input.receiptId, idempotencyKey: input.idempotencyKey });
      writeJson(response, 200, { cwd: store.paths.cwd, receipt });
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 400;
      writeJson(response, status, { error: error instanceof HttpError ? error.code : "bad_request",
        message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  const kind = url.searchParams.get("sourceKind");
  const scope = url.searchParams.get("sourceScope") ?? undefined;
  if (!cwd || kind !== "channel_task" && kind !== "automation_run") {
    writeJson(response, 400, { error: "bad_request", message: "cwd and a native intake sourceKind are required." });
    return;
  }
  try {
    const store = stores.getStore(cwd);
    const limit = Math.min(readOptionalIntegerQuery(url, "limit", 1) ?? 50, 200);
    writeJson(response, 200, { cwd: store.paths.cwd, receipts: store.listNativeWorkIntakeReceipts(kind, scope, limit) });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}
