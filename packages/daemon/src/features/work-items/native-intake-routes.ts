import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { writeJson } from "../../shared/response.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { isRecord } from "../../shared/validation.js";
import { HttpError } from "../../errors.js";
import { recoveryBlocked } from "../../server/app-server-recovery.js";
import type { NativeWorkIntake } from "./native-intake.js";
import { listNativeWorkIntake, mutateNativeWorkIntake, readNativeWorkIntakeListRequest, readNativeWorkIntakeMutation } from "./native-intake-requests.js";

export async function handleNativeWorkIntakeCollection(
  request: IncomingMessage, response: ServerResponse, url: URL, stores: RunStoreRegistry,
  nativeIntake: NativeWorkIntake | undefined, maxBodyBytes: number,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Read or re-evaluate native intake receipts." });
    return;
  }
  try {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "bad_request", "cwd is required.");
    if (request.method === "GET") {
      const input = readNativeWorkIntakeListRequest({
        sourceKind: url.searchParams.get("sourceKind"), sourceScope: url.searchParams.get("sourceScope") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }, 200);
      writeJson(response, 200, listNativeWorkIntake(stores.getStore(cwd), input));
      return;
    }
    if (!nativeIntake) throw new HttpError(404, "native_intake_unavailable", "Native intake is unavailable.");
    const body = await readJsonBody(request, maxBodyBytes);
    if (!isRecord(body)) throw new HttpError(400, "bad_request", "Supply an intake receipt request.");
    const input = readNativeWorkIntakeMutation("retry", body);
    if (stores.recoveryBlocksDispatch(cwd)) throw recoveryBlocked();
    writeJson(response, 200, mutateNativeWorkIntake(stores.getStore(cwd), nativeIntake, input));
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request", message: error instanceof Error ? error.message : String(error),
    });
  }
}
