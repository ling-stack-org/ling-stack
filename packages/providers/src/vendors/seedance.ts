import { MediaAdapterExecutionError } from "../errors.js";
import { defaultMediaVendorHttpClient, getMediaVendorResponseHeader, mapMediaVendorHttpStatus, parseContentLength, readHttpResponseBody } from "../media-vendor-http.js";
import { redactSecretText, redactSecrets } from "../redaction.js";
import type {
  LiveMediaVendorTransportOptions,
  MediaExecutionHandle,
  MediaExecutionPollResult,
  MediaExecutionResult,
  MediaExecutionSubmission,
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

export async function submitSeedanceVideoTask(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaExecutionSubmission> {
  const endpoint = `${options.baseUrl?.replace(/\/+$/, "")}/contents/generations/tasks`;
  const payload = buildSeedanceVideoTaskPayload(request.requestPlan);
  const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS);
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
      const failure = await normalizeSeedanceHttpFailure(response, mediaVendorRedactionValues(options));
      return { status: "failed", errorCode: failure.errorCode, errorMessage: failure.errorMessage ?? "Seedance video task creation failed." };
    }
    const createResponse = await response.json();
    const externalOperationId = extractSeedanceTaskId(createResponse);
    if (!externalOperationId) {
      return { status: "failed", errorCode: "invalid_request", errorMessage: "Seedance video task response did not include task id." };
    }
    const statusEndpoint = `${options.baseUrl?.replace(/\/+$/, "")}/contents/generations/tasks/${encodeURIComponent(externalOperationId)}`;
    const requestSummary = summarizeSeedanceRequest(payload);
    return {
      status: "submitted",
      handle: {
        adapterKind: "seedance",
        externalOperationId,
        recovery: {
          statusEndpoint,
          requestSummary,
          ...(extractSeedanceVideoUrl(createResponse) ? { videoUrl: extractSeedanceVideoUrl(createResponse) } : {}),
        },
      },
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      status: "failed",
      errorCode: isTimeout ? "timeout" : "network_error",
      errorMessage: redactSecretText(
        isTimeout ? "Seedance video task creation timed out." : error instanceof Error ? error.message : String(error),
        mediaVendorRedactionValues(options),
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function pollSeedanceVideoTask(
  handle: MediaExecutionHandle,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaExecutionPollResult> {
  if (handle.adapterKind !== "seedance") {
    return { status: "failed", errorCode: "unsupported_capability", errorMessage: "Unsupported media execution handle." };
  }
  const statusEndpoint = readRecoveryString(handle.recovery, "statusEndpoint");
  const existingVideoUrl = readRecoveryString(handle.recovery, "videoUrl");
  if (existingVideoUrl) {
    return { status: "succeeded", recovery: handle.recovery };
  }
  if (!statusEndpoint) {
    return { status: "failed", errorCode: "invalid_request", errorMessage: "Seedance execution handle is missing a status endpoint." };
  }
  const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
  try {
    const response = await httpClient(statusEndpoint, {
      method: "GET",
      headers: { ...options.headers, authorization: `Bearer ${options.apiKey}` },
    });
    if (!response.ok) {
      const failure = await normalizeSeedanceStatusHttpFailure(response, mediaVendorRedactionValues(options));
      return { status: "failed", errorCode: failure.errorCode, errorMessage: failure.errorMessage };
    }
    const statusResponse = await response.json();
    const videoUrl = extractSeedanceVideoUrl(statusResponse);
    if (videoUrl) {
      return {
        status: "succeeded",
        recovery: {
          statusEndpoint,
          requestSummary: handle.recovery.requestSummary,
          videoUrl,
        },
      };
    }
    if (readSeedanceTaskStatus(statusResponse) === "pending") {
      return { status: "pending" };
    }
    return {
      status: "failed",
      errorCode: "provider_internal_error",
      errorMessage: `Seedance video task ${handle.externalOperationId} did not return a usable video result.`,
    };
  } catch (error) {
    return {
      status: "failed",
      errorCode: "network_error",
      errorMessage: redactSecretText(error instanceof Error ? error.message : String(error), mediaVendorRedactionValues(options)),
    };
  }
}

export async function collectSeedanceVideoArtifacts(
  handle: MediaExecutionHandle,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaExecutionResult> {
  const videoUrl = readRecoveryString(handle.recovery, "videoUrl");
  if (!videoUrl) {
    return { status: "failed", artifacts: [], errorCode: "invalid_request", errorMessage: "Seedance execution handle has no completed video URL." };
  }
  try {
    const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), options.timeoutMs ?? DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS);
    try {
      const videoArtifact = await downloadSeedanceVideoArtifact(videoUrl, httpClient, abortController.signal);
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
              taskId: handle.externalOperationId,
              statusEndpoint: readRecoveryString(handle.recovery, "statusEndpoint"),
              requestSummary: handle.recovery.requestSummary,
            }, mediaVendorRedactionValues(options)), null, 2),
          },
          videoArtifact,
        ],
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      status: "failed",
      artifacts: [],
      errorCode: isTimeout ? "timeout" : "network_error",
      errorMessage: redactSecretText(error instanceof Error ? error.message : String(error), mediaVendorRedactionValues(options)),
    };
  }
}

export async function cancelSeedanceVideoTask(_handle: MediaExecutionHandle): Promise<void> {
  // Seedance's current public task endpoint has no verified cancel mapping. Keep the daemon cancellation local until one exists.
}

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
            requestSummary: summarizeSeedanceRequest(payload),
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
  const videoImageInputs = plan.payload.videoImageInputs ?? [];
  assertSeedanceVideoImageInputs(videoImageInputs, plan.provider.model);
  return removeUndefined({
    model: plan.provider.model,
    content: [
      {
        type: "text",
        text: plan.payload.prompt,
      },
      ...videoImageInputs.map((image) => ({
        type: "image_url",
        image_url: { url: image.imageUrl },
        role: image.role,
      })),
    ],
    ratio: typeof input.ratio === "string" ? input.ratio : "16:9",
    duration: typeof input.duration === "number" ? input.duration : 5,
    watermark: typeof input.watermark === "boolean" ? input.watermark : false,
  });
}

function assertSeedanceVideoImageInputs(
  inputs: NonNullable<MediaVendorRequestPlan["payload"]["videoImageInputs"]>,
  model: string,
): void {
  if (inputs.length === 0) {
    return;
  }
  const roles = new Set(inputs.map((input) => input.role));
  if (roles.size > 1) {
    throw new MediaAdapterExecutionError("invalid_request", "Seedance image inputs must use one role.");
  }
  if (inputs.some((input) => !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageUrl))) {
    throw new MediaAdapterExecutionError("invalid_request", "Seedance image inputs must use JPEG, PNG, or WebP Data URLs.");
  }
  const version = resolveSeedanceVersion(model);
  if (!version) {
    throw new MediaAdapterExecutionError("unsupported_capability", "Unknown Seedance model versions do not accept image inputs.");
  }
  const role = inputs[0]?.role;
  if (role === "first_frame" && inputs.length !== 1) {
    throw new MediaAdapterExecutionError("invalid_request", "Seedance first-frame mode requires exactly one image.");
  }
  if (role === "reference_image") {
    const limit = version === "2.0" ? 9 : version === "2.5" ? 30 : undefined;
    if (!limit) {
      throw new MediaAdapterExecutionError("unsupported_capability", `Seedance ${version} does not accept reference images.`);
    }
    if (inputs.length > limit) {
      throw new MediaAdapterExecutionError("invalid_request", `Seedance ${version} accepts at most ${limit} reference images.`);
    }
  }
}

function resolveSeedanceVersion(model: string): "1.0" | "1.5" | "2.0" | "2.5" | undefined {
  const normalized = model.trim().toLowerCase().replace(/[:\s._/]+/g, "-");
  const match = normalized.match(/(?:^|-)seedance-(1-0|1-5|2-0|2-5)(?:-|$)/);
  return match?.[1]?.replace("-", ".") as "1.0" | "1.5" | "2.0" | "2.5" | undefined;
}

function summarizeSeedanceRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const images = content.filter((item) => isRecord(item) && item.type === "image_url");
  const role = images.length > 0 && isRecord(images[0]) &&
      (images[0].role === "first_frame" || images[0].role === "reference_image")
    ? images[0].role
    : undefined;
  return removeUndefined({
    model: typeof payload.model === "string" ? payload.model : undefined,
    ratio: typeof payload.ratio === "string" ? payload.ratio : undefined,
    duration: typeof payload.duration === "number" ? payload.duration : undefined,
    watermark: typeof payload.watermark === "boolean" ? payload.watermark : undefined,
    inputMode: role ?? "text",
    imageCount: images.length,
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

function readRecoveryString(recovery: Record<string, unknown>, key: string): string | undefined {
  const value = recovery[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
