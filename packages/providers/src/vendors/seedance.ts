import { MediaAdapterExecutionError } from "../errors.js";
import { defaultMediaVendorHttpClient, getMediaVendorResponseHeader, mapMediaVendorHttpStatus, parseContentLength, readHttpResponseBody } from "../media-vendor-http.js";
import { redactSecretText, redactSecrets } from "../redaction.js";
import type {
  LiveMediaVendorTransportOptions,
  MediaExecutionArtifact,
  MediaVendorHttpClient,
  MediaVendorHttpResponse,
  MediaVendorRequestPlan,
  MediaVendorTransportRequest,
  MediaVendorTransportResult,
} from "../types.js";
import { isRecord, removeUndefined } from "../utils.js";

const MAX_MEDIA_VENDOR_VIDEO_BYTES = 512 * 1024 * 1024;
const DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS = 180_000;
const DEFAULT_SEEDANCE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_SEEDANCE_MAX_POLL_ATTEMPTS = 90;

type SeedanceFinalVideoSuccess = { readonly status: "succeeded"; readonly videoUrl: string; readonly statusResponse: unknown };
type SeedanceFinalVideoFailure = { readonly status: "failed"; readonly errorCode: MediaVendorTransportResult["errorCode"]; readonly errorMessage: string };
type SeedanceFinalVideoResolution = SeedanceFinalVideoSuccess | SeedanceFinalVideoFailure;

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
        ...options.headers,
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });
    if (!response.ok) {
      return await normalizeSeedanceHttpFailure(response, mediaVendorRedactionValues(options));
    }

    const createJson = await response.json();
    const taskId = extractSeedanceTaskId(createJson);
    if (!taskId) {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: "Seedance video task response did not include task id.",
      };
    }

    const statusEndpoint = `${options.baseUrl?.replace(/\/+$/, "")}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
    const final = await waitForSeedanceFinalVideo({
      statusEndpoint,
      taskId,
      httpClient,
      options,
      signal: abortController.signal,
      createResponse: createJson,
    });
    if (final.status === "failed") {
      return final;
    }
    const videoArtifact = await downloadSeedanceVideoArtifact(final.videoUrl, httpClient, abortController.signal);

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: "Seedance video_generate response",
          contentType: "application/json; charset=utf-8",
          pathHint: "seedance-video-response.json",
          content: JSON.stringify(redactSecrets({
            mode: "live_seedance_video_generate_final",
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            statusEndpoint,
            taskId,
            request: payload,
            createResponse: createJson,
            statusResponse: final.statusResponse,
          }, mediaVendorRedactionValues(options)), null, 2),
        },
        videoArtifact,
      ],
    };
  } catch (error) {
    if (error instanceof MediaAdapterExecutionError) {
      return {
        status: "failed",
        errorCode: error.code,
        errorMessage: redactSecretText(error.message, mediaVendorRedactionValues(options)),
      };
    }
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const message = isTimeout
      ? `Media vendor request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
      : error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      errorCode: isTimeout ? "timeout" : "network_error",
      errorMessage: redactSecretText(message, mediaVendorRedactionValues(options)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForSeedanceFinalVideo(input: {
  readonly statusEndpoint: string;
  readonly taskId: string;
  readonly httpClient: MediaVendorHttpClient;
  readonly options: LiveMediaVendorTransportOptions;
  readonly signal: AbortSignal;
  readonly createResponse: unknown;
}): Promise<
  SeedanceFinalVideoResolution
> {
  const firstVideoUrl = extractSeedanceVideoUrl(input.createResponse);
  if (firstVideoUrl) {
    return { status: "succeeded", videoUrl: firstVideoUrl, statusResponse: input.createResponse };
  }

  const pollIntervalMs = Math.max(0, input.options.pollIntervalMs ?? DEFAULT_SEEDANCE_POLL_INTERVAL_MS);
  const maxPollAttempts = Math.max(1, input.options.maxPollAttempts ?? DEFAULT_SEEDANCE_MAX_POLL_ATTEMPTS);
  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    if (attempt > 1) {
      await waitForPollDelay(pollIntervalMs, input.signal);
    }
    const response = await input.httpClient(input.statusEndpoint, {
      method: "GET",
      headers: {
        ...input.options.headers,
        authorization: `Bearer ${input.options.apiKey}`,
      },
      signal: input.signal,
    });
    if (!response.ok) {
      return await normalizeSeedanceStatusHttpFailure(response, mediaVendorRedactionValues(input.options));
    }
    const json = await response.json();
    const videoUrl = extractSeedanceVideoUrl(json);
    if (videoUrl) {
      return { status: "succeeded", videoUrl, statusResponse: json };
    }
    const taskStatus = readSeedanceTaskStatus(json);
    if (taskStatus === "failed") {
      return {
        status: "failed",
        errorCode: "provider_internal_error",
        errorMessage: redactSecretText(`Seedance video task ${input.taskId} failed before returning a video URL.`, mediaVendorRedactionValues(input.options)),
      };
    }
    if (taskStatus === "unknown") {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: "Seedance video task status response did not include a recognizable status or final video URL.",
      };
    }
  }
  return {
    status: "failed",
    errorCode: "timeout",
    errorMessage: `Seedance video task ${input.taskId} did not return a final video URL before polling timed out.`,
  };
}

function waitForPollDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(abortError());
    }, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

async function downloadSeedanceVideoArtifact(
  videoUrl: string,
  httpClient: MediaVendorHttpClient,
  signal: AbortSignal,
): Promise<MediaExecutionArtifact> {
  const parsedUrl = parseMediaVideoUrl(videoUrl);
  const response = await httpClient(parsedUrl.toString(), {
    method: "GET",
    headers: {},
    signal,
  });
  if (!response.ok) {
    throw new MediaAdapterExecutionError(
      mapMediaVendorHttpStatus(response.status),
      `Seedance video download failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    );
  }
  const contentType = getMediaVendorResponseHeader(response, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isSupportedSeedanceVideoContentType(contentType, parsedUrl)) {
    throw new MediaAdapterExecutionError(
      "invalid_request",
      `Seedance video URL returned non-video content type: ${contentType || "unknown"}.`,
    );
  }
  const declaredLength = parseContentLength(getMediaVendorResponseHeader(response, "content-length"));
  if (declaredLength !== undefined && declaredLength > MAX_MEDIA_VENDOR_VIDEO_BYTES) {
    throw new MediaAdapterExecutionError(
      "invalid_request",
      `Seedance video exceeds ${MAX_MEDIA_VENDOR_VIDEO_BYTES} byte limit.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_VENDOR_VIDEO_BYTES) {
    throw new MediaAdapterExecutionError(
      "invalid_request",
      `Seedance video exceeds ${MAX_MEDIA_VENDOR_VIDEO_BYTES} byte limit.`,
    );
  }
  const artifactContentType = contentType || contentTypeForVideoUrl(parsedUrl);
  return {
    type: "video",
    title: "Seedance video",
    contentType: artifactContentType,
    pathHint: `seedance-video.${videoExtensionForContentType(artifactContentType, parsedUrl)}`,
    contentBytes: bytes,
  };
}

function parseMediaVideoUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaAdapterExecutionError("invalid_request", "Seedance response included an invalid video URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaAdapterExecutionError("invalid_request", "Seedance video URL must use http or https.");
  }
  return url;
}

function isSupportedSeedanceVideoContentType(contentType: string, url: URL): boolean {
  if (contentType.startsWith("video/")) {
    return true;
  }
  const extension = videoExtensionFromUrl(url);
  if ((contentType === "" || contentType === "application/octet-stream" || contentType === "binary/octet-stream") && extension) {
    return true;
  }
  return false;
}

function contentTypeForVideoUrl(url: URL): string {
  const extension = videoExtensionFromUrl(url);
  if (extension === "webm") {
    return "video/webm";
  }
  if (extension === "mov") {
    return "video/quicktime";
  }
  return "video/mp4";
}

function videoExtensionForContentType(contentType: string, url: URL): string {
  if (contentType === "video/webm") {
    return "webm";
  }
  if (contentType === "video/quicktime") {
    return "mov";
  }
  return videoExtensionFromUrl(url) ?? "mp4";
}

function videoExtensionFromUrl(url: URL): string | undefined {
  const match = url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) {
    return undefined;
  }
  return ["mp4", "webm", "mov", "m4v"].includes(match[1]) ? match[1] : undefined;
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

function mediaVendorRedactionValues(options: LiveMediaVendorTransportOptions): readonly string[] {
  return [
    options.apiKey,
    ...(options.redactionValues ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function normalizeSeedanceHttpFailure(response: MediaVendorHttpResponse, redactionValues: readonly string[]): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, redactionValues);
  return {
    status: "failed",
    errorCode: mapMediaVendorHttpStatus(response.status),
    errorMessage: `Seedance video task creation failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${
      redactedBody ? ` ${redactedBody}` : ""
    }`.trim(),
  };
}

async function normalizeSeedanceStatusHttpFailure(response: MediaVendorHttpResponse, redactionValues: readonly string[]): Promise<SeedanceFinalVideoFailure> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, redactionValues);
  return {
    status: "failed",
    errorCode: mapMediaVendorHttpStatus(response.status),
    errorMessage: `Seedance video task status failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${
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

function extractSeedanceVideoUrl(value: unknown): string | undefined {
  for (const record of flattenSeedanceRecords(value)) {
    for (const key of ["video_url", "videoUrl", "url"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return undefined;
}

function readSeedanceTaskStatus(value: unknown): "pending" | "failed" | "unknown" {
  for (const record of flattenSeedanceRecords(value)) {
    for (const key of ["status", "state", "task_status", "taskStatus"]) {
      const candidate = record[key];
      if (typeof candidate !== "string") {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (["queued", "pending", "running", "processing", "submitted", "in_progress", "in-progress"].includes(normalized)) {
        return "pending";
      }
      if (["failed", "error", "cancelled", "canceled", "rejected"].includes(normalized)) {
        return "failed";
      }
      if (["succeeded", "success", "completed", "complete", "done"].includes(normalized)) {
        return "unknown";
      }
    }
  }
  return "unknown";
}

function flattenSeedanceRecords(value: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 4 || !isRecord(candidate)) {
      return;
    }
    records.push(candidate);
    for (const key of ["data", "content", "output", "result", "task"]) {
      visit(candidate[key], depth + 1);
    }
    const content = candidate.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return records;
}
