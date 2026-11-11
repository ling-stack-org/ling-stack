import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { readJsonBody } from "../../../shared/request.js";
import { writeJson } from "../../../shared/response.js";
import { isRecord } from "../../../shared/validation.js";
import { projectInitializedAssuranceEvaluationAssociation } from "./assurance-association-composition.js";
import { FROZEN_INPUT_KEYS, type AssuranceEvaluationAssociationRequest, type FrozenInputKey } from "./assurance-association-contract.js";
import type { ActiveRunRegistry } from "../../../runtime/active-runs.js";

const MAX_FROZEN_INPUT_BYTES = 1_048_576;
const MAX_ASSOCIATION_REQUEST_BODY_BYTES = 10 * 1_048_576;

/** Read-only HTTP entry point for associating one frozen observation with one stored evaluation. */
export async function handlePostRunAssuranceEvaluationAssociation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  maxBodyBytes: number,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for /runs/:id/assurance-evaluation-association`,
    });
    return;
  }
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "cwd_required", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = parseAssociationBody(await readJsonBody(request, Math.max(maxBodyBytes, MAX_ASSOCIATION_REQUEST_BODY_BYTES)));
    const result = projectInitializedAssuranceEvaluationAssociation({
      registry: storeRegistry,
      activeRuns,
      cwd,
      runId,
      request: body.request,
      getFrozenInput: key => body.frozenInputs[key],
    });
    writeJson(response, 200, result);
  } catch {
    writeJson(response, 400, {
      error: "assurance_association_invalid_request",
      message: "The assurance evaluation association request is invalid.",
    });
  }
}

function parseAssociationBody(value: unknown): {
  readonly request: AssuranceEvaluationAssociationRequest;
  readonly frozenInputs: Readonly<Record<FrozenInputKey, Uint8Array>>;
} {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.frozenInputs)
    || Object.keys(value).some(key => key !== "request" && key !== "frozenInputs")) {
    throw new AssociationHttpRequestError();
  }
  const frozenInputs = {} as Record<FrozenInputKey, Uint8Array>;
  for (const key of FROZEN_INPUT_KEYS) {
    const encoded = value.frozenInputs[key];
    if (typeof encoded !== "string") throw new AssociationHttpRequestError();
    frozenInputs[key] = decodeBase64(encoded);
  }
  if (Object.keys(value.frozenInputs).some(key => !(FROZEN_INPUT_KEYS as readonly string[]).includes(key))) {
    throw new AssociationHttpRequestError();
  }
  return { request: value.request as unknown as AssuranceEvaluationAssociationRequest, frozenInputs };
}

function decodeBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new AssociationHttpRequestError();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.byteLength > MAX_FROZEN_INPUT_BYTES) {
    throw new AssociationHttpRequestError();
  }
  return bytes;
}

class AssociationHttpRequestError extends Error {}
