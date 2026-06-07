import { MediaAdapterExecutionError } from "../errors.js";
import { defaultMediaVendorHttpClient, mapMediaVendorHttpStatus, readHttpResponseBody } from "../media-vendor-http.js";
import { redactSecretText, redactSecrets } from "../redaction.js";
import type { LiveMediaVendorTransportOptions, MediaVendorHttpResponse, MediaVendorRequestPlan, MediaVendorTransportRequest, MediaVendorTransportResult } from "../types.js";
import { isRecord, removeUndefined } from "../utils.js";

const DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS = 180_000;

export async function executeSeedanceVideoTask(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${options.baseUrl?.replace(/\/+$/, "")}/contents/generations/tasks`;
  const payload = buildSeedanceVideoTaskPayload(request.requestPlan);
  const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
  const abortController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await httpClient(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
    if (!response.ok) {
      return await normalizeSeedanceHttpFailure(response, options.apiKey);
    }

    const json = await response.json();
    const taskId = extractSeedanceTaskId(json);
    if (!taskId) {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: "Seedance video task response did not include task id.",
      };
    }

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: "Seedance video_generate task response",
          contentType: "application/json; charset=utf-8",
          pathHint: "seedance-video-task-response.json",
          content: JSON.stringify(redactSecrets({
            mode: "live_seedance_video_generate_task",
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            taskId,
            request: payload,
            response: json,
          }, [options.apiKey]), null, 2),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MediaAdapterExecutionError) {
      return {
        status: "failed",
        errorCode: error.code,
        errorMessage: redactSecretText(error.message, [options.apiKey]),
      };
    }
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const message = isTimeout
      ? `Media vendor request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      : error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      errorCode: isTimeout ? "timeout" : "network_error",
      errorMessage: redactSecretText(message, [options.apiKey]),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSeedanceVideoTaskPayload(plan: MediaVendorRequestPlan): Record<string, unknown> {
  const input = isRecord(plan.payload.input) ? plan.payload.input : {};
  return removeUndefined({
    model: plan.provider.model,
    content: [
      {
        type: "text",
        text: plan.payload.prompt,
      },
    ],
    ratio: typeof input.ratio === "string" ? input.ratio : "16:9",
    duration: typeof input.duration === "number" ? input.duration : 5,
    watermark: typeof input.watermark === "boolean" ? input.watermark : false,
  });
}

async function normalizeSeedanceHttpFailure(response: MediaVendorHttpResponse, apiKey: string | undefined): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, [apiKey]);
  return {
    status: "failed",
    errorCode: mapMediaVendorHttpStatus(response.status),
    errorMessage: `Seedance video task creation failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${
      redactedBody ? ` ${redactedBody}` : ""
    }`.trim(),
  };
}

function extractSeedanceTaskId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id === "string" && value.id.trim()) {
    return value.id;
  }
  const data = value.data;
  if (isRecord(data) && typeof data.id === "string" && data.id.trim()) {
    return data.id;
  }
  return undefined;
}
