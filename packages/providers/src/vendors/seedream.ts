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
import { isRecord, removeUndefined, stripTrailingSlashes } from "../utils.js";

const MAX_MEDIA_VENDOR_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS = 180_000;

export async function executeSeedreamImageGeneration(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${stripTrailingSlashes(options.baseUrl)}/images/generations`;
  const payload = buildSeedreamImageGenerationPayload(request.requestPlan);
  return await executeSeedreamImageRequest({
    request,
    options,
    endpoint,
    payload,
    mode: "live_seedream_image_generate",
    title: "Seedream image_generate response",
    responsePathHint: "seedream-image-response.json",
    missingImageMessage: "Seedream image generation response did not include image URL data.",
  });
}

export async function executeSeedreamImageEdit(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${stripTrailingSlashes(options.baseUrl)}/images/generations`;
  const payloadResolution = buildSeedreamImageEditPayload(request.requestPlan);
  if (!payloadResolution.ok) {
    return {
      status: "failed",
      errorCode: "invalid_request",
      errorMessage: payloadResolution.errorMessage,
    };
  }
  return await executeSeedreamImageRequest({
    request,
    options,
    endpoint,
    payload: payloadResolution.payload,
    mode: "live_seedream_image_edit",
    title: "Seedream image_edit response",
    responsePathHint: "seedream-image-edit-response.json",
    missingImageMessage: "Seedream image edit response did not include image URL data.",
  });
}

async function executeSeedreamImageRequest(input: {
  readonly request: MediaVendorTransportRequest;
  readonly options: LiveMediaVendorTransportOptions;
  readonly endpoint: string;
  readonly payload: Record<string, unknown>;
  readonly mode: "live_seedream_image_generate" | "live_seedream_image_edit";
  readonly title: string;
  readonly responsePathHint: string;
  readonly missingImageMessage: string;
}): Promise<MediaVendorTransportResult> {
  const { endpoint, options, payload, request } = input;
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
      return await normalizeSeedreamHttpFailure(response, mediaVendorRedactionValues(options));
    }

    const json = await response.json();
    const imageUrls = extractSeedreamImageUrls(json);
    if (imageUrls.length === 0) {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: input.missingImageMessage,
      };
    }
    const imageArtifacts = await downloadSeedreamImageArtifacts(imageUrls, httpClient, abortController.signal);

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: input.title,
          contentType: "application/json; charset=utf-8",
          pathHint: input.responsePathHint,
          content: JSON.stringify(redactSecrets({
            mode: input.mode,
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            imageCount: imageUrls.length,
            request: payload,
            response: json,
          }, mediaVendorRedactionValues(options)), null, 2),
        },
        ...imageArtifacts,
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

function buildSeedreamImageGenerationPayload(plan: MediaVendorRequestPlan): Record<string, unknown> {
  const input = isRecord(plan.payload.input) ? plan.payload.input : {};
  return removeUndefined({
    model: plan.provider.model,
    prompt: plan.payload.prompt,
    response_format: typeof input.response_format === "string" ? input.response_format : "url",
    size: typeof input.size === "string" ? input.size : undefined,
    n: typeof input.n === "number" ? input.n : undefined,
    watermark: typeof input.watermark === "boolean" ? input.watermark : undefined,
    seed: typeof input.seed === "number" ? input.seed : undefined,
  });
}

function buildSeedreamImageEditPayload(plan: MediaVendorRequestPlan): (
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly errorMessage: string }
) {
  const input = isRecord(plan.payload.input) ? plan.payload.input : {};
  const imageInputs = readSeedreamImageInputs(input);
  if (imageInputs.length === 0) {
    return {
      ok: false,
      errorMessage: "Seedream image_edit requires at least one source image URL.",
    };
  }
  const invalidImage = imageInputs.find((item) => !isSupportedSeedreamImageInput(item));
  if (invalidImage) {
    return {
      ok: false,
      errorMessage: "Seedream image_edit source images must be http(s) URLs or data:image base64 URLs.",
    };
  }
  const mask = readOptionalString(input.maskUrl ?? input.mask_url ?? input.mask);
  if (mask && !isSupportedSeedreamImageInput(mask)) {
    return {
      ok: false,
      errorMessage: "Seedream image_edit mask image must be an http(s) URL or data:image base64 URL.",
    };
  }

  return {
    ok: true,
    payload: removeUndefined({
      model: plan.provider.model,
      prompt: plan.payload.prompt,
      image: imageInputs.length === 1 ? imageInputs[0] : imageInputs,
      mask,
      response_format: typeof input.response_format === "string" ? input.response_format : "url",
      size: typeof input.size === "string" ? input.size : undefined,
      n: typeof input.n === "number" ? input.n : undefined,
      watermark: typeof input.watermark === "boolean" ? input.watermark : undefined,
      seed: typeof input.seed === "number" ? input.seed : undefined,
    }),
  };
}

function readSeedreamImageInputs(input: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["imageUrl", "image_url", "image"]) {
    const value = readOptionalString(input[key]);
    if (value) {
      values.push(value);
    }
  }
  for (const key of ["imageUrls", "image_urls", "images"]) {
    const value = input[key];
    if (Array.isArray(value)) {
      values.push(...value.map((item) => readOptionalString(item)).filter((item): item is string => Boolean(item)));
    }
  }
  return [...new Set(values)];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSupportedSeedreamImageInput(value: string): boolean {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function downloadSeedreamImageArtifacts(
  imageUrls: readonly string[],
  httpClient: MediaVendorHttpClient,
  signal: AbortSignal,
): Promise<MediaExecutionArtifact[]> {
  const artifacts: MediaExecutionArtifact[] = [];
  for (const [index, imageUrl] of imageUrls.entries()) {
    const parsedUrl = parseMediaImageUrl(imageUrl);
    const response = await httpClient(parsedUrl.toString(), {
      method: "GET",
      headers: {},
      signal,
    });
    if (!response.ok) {
      throw new MediaAdapterExecutionError(
        mapMediaVendorHttpStatus(response.status),
        `Seedream image download failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
      );
    }
    const contentType = getMediaVendorResponseHeader(response, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image URL returned non-image content type: ${contentType || "unknown"}.`,
      );
    }
    const declaredLength = parseContentLength(getMediaVendorResponseHeader(response, "content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_MEDIA_VENDOR_IMAGE_BYTES) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image exceeds ${MAX_MEDIA_VENDOR_IMAGE_BYTES} byte limit.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_VENDOR_IMAGE_BYTES) {
      throw new MediaAdapterExecutionError(
        "invalid_request",
        `Seedream image exceeds ${MAX_MEDIA_VENDOR_IMAGE_BYTES} byte limit.`,
      );
    }
    artifacts.push({
      type: "image",
      title: `Seedream image ${index + 1}`,
      contentType,
      pathHint: `seedream-image-${index + 1}.${imageExtensionForContentType(contentType)}`,
      contentBytes: bytes,
    });
  }
  return artifacts;
}

function parseMediaImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaAdapterExecutionError("invalid_request", "Seedream image response included an invalid image URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaAdapterExecutionError("invalid_request", "Seedream image URL must use http or https.");
  }
  return url;
}

function imageExtensionForContentType(contentType: string): string {
  if (contentType === "image/jpeg" || contentType === "image/jpg") {
    return "jpg";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  if (contentType === "image/svg+xml") {
    return "svg";
  }
  return "png";
}

function mediaVendorRedactionValues(options: LiveMediaVendorTransportOptions): readonly string[] {
  return [
    options.apiKey,
    ...(options.redactionValues ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function normalizeSeedreamHttpFailure(response: MediaVendorHttpResponse, redactionValues: readonly string[]): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, redactionValues);
  return {
    status: "failed",
    errorCode: mapMediaVendorHttpStatus(response.status),
    errorMessage: `Seedream image generation failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${
      redactedBody ? ` ${redactedBody}` : ""
    }`.trim(),
  };
}

function extractSeedreamImageUrls(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.url === "string")
    .map((item) => item.url as string);
}
