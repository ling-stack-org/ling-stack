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

const MAX_OPENAI_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_OPENAI_IMAGES_TIMEOUT_MS = 180_000;

export async function executeOpenAIImageGeneration(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${stripTrailingSlashes(options.baseUrl)}/images/generations`;
  const payload = buildOpenAIImageGenerationPayload(request.requestPlan);
  const httpClient = options.httpClient ?? defaultMediaVendorHttpClient;
  const abortController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_IMAGES_TIMEOUT_MS;
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
      return await normalizeOpenAIImagesHttpFailure(response, mediaVendorRedactionValues(options));
    }

    const json = await response.json();
    const imageArtifacts = await extractOpenAIImageArtifacts(json, httpClient, abortController.signal);
    if (imageArtifacts.length === 0) {
      return {
        status: "failed",
        errorCode: "media_result_unavailable",
        errorMessage: "OpenAI Images response did not include image data.",
      };
    }

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: "OpenAI image_generate response",
          contentType: "application/json; charset=utf-8",
          pathHint: "openai-image-response.json",
          content: JSON.stringify(redactSecrets({
            mode: "live_openai_image_generate",
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            imageCount: imageArtifacts.length,
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

function buildOpenAIImageGenerationPayload(plan: MediaVendorRequestPlan): Record<string, unknown> {
  const input = isRecord(plan.payload.input) ? plan.payload.input : {};
  return removeUndefined({
    model: plan.provider.model,
    prompt: plan.payload.prompt,
    response_format: "b64_json",
    size: typeof input.size === "string" ? input.size : undefined,
    n: typeof input.n === "number" ? input.n : undefined,
    watermark: typeof input.watermark === "boolean" ? input.watermark : undefined,
    seed: typeof input.seed === "number" ? input.seed : undefined,
  });
}

async function extractOpenAIImageArtifacts(
  value: unknown,
  httpClient: MediaVendorHttpClient,
  signal: AbortSignal,
): Promise<MediaExecutionArtifact[]> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  const artifacts: MediaExecutionArtifact[] = [];
  for (const [index, item] of value.data.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.b64_json === "string" && item.b64_json.trim()) {
      artifacts.push(openAIImageArtifactFromBase64(item.b64_json, index));
      continue;
    }
    if (typeof item.url === "string" && item.url.trim()) {
      artifacts.push(await downloadOpenAIImageArtifact(item.url, index, httpClient, signal));
    }
  }
  return artifacts;
}

function openAIImageArtifactFromBase64(base64: string, index: number): MediaExecutionArtifact {
  const bytes = base64ToBytes(base64);
  if (bytes.byteLength > MAX_OPENAI_IMAGE_BYTES) {
    throw new MediaAdapterExecutionError("invalid_request", `OpenAI image exceeds ${MAX_OPENAI_IMAGE_BYTES} byte limit.`);
  }
  return {
    type: "image",
    title: `OpenAI image ${index + 1}`,
    contentType: "image/png",
    pathHint: `openai-image-${index + 1}.png`,
    contentBytes: bytes,
  };
}

async function downloadOpenAIImageArtifact(
  imageUrl: string,
  index: number,
  httpClient: MediaVendorHttpClient,
  signal: AbortSignal,
): Promise<MediaExecutionArtifact> {
  const parsedUrl = parseOpenAIImageUrl(imageUrl);
  const response = await httpClient(parsedUrl.toString(), {
    method: "GET",
    headers: {},
    signal,
  });
  if (!response.ok) {
    throw new MediaAdapterExecutionError(
      mapMediaVendorHttpStatus(response.status),
      `OpenAI image download failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    );
  }
  const contentType = getMediaVendorResponseHeader(response, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new MediaAdapterExecutionError(
      "invalid_request",
      `OpenAI image URL returned non-image content type: ${contentType || "unknown"}.`,
    );
  }
  const declaredLength = parseContentLength(getMediaVendorResponseHeader(response, "content-length"));
  if (declaredLength !== undefined && declaredLength > MAX_OPENAI_IMAGE_BYTES) {
    throw new MediaAdapterExecutionError("invalid_request", `OpenAI image exceeds ${MAX_OPENAI_IMAGE_BYTES} byte limit.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OPENAI_IMAGE_BYTES) {
    throw new MediaAdapterExecutionError("invalid_request", `OpenAI image exceeds ${MAX_OPENAI_IMAGE_BYTES} byte limit.`);
  }
  return {
    type: "image",
    title: `OpenAI image ${index + 1}`,
    contentType,
    pathHint: `openai-image-${index + 1}.${imageExtensionForContentType(contentType)}`,
    contentBytes: bytes,
  };
}

function parseOpenAIImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaAdapterExecutionError("invalid_request", "OpenAI Images response included an invalid image URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MediaAdapterExecutionError("invalid_request", "OpenAI image URL must use http or https.");
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function mediaVendorRedactionValues(options: LiveMediaVendorTransportOptions): readonly string[] {
  return [
    options.apiKey,
    ...(options.redactionValues ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function normalizeOpenAIImagesHttpFailure(response: MediaVendorHttpResponse, redactionValues: readonly string[]): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, redactionValues);
  return {
    status: "failed",
    errorCode: openAIImagesFailureCode(response.status, body),
    errorMessage: `OpenAI image generation failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.${
      redactedBody ? ` ${redactedBody}` : ""
    }`.trim(),
  };
}

function openAIImagesFailureCode(status: number, body: string): MediaVendorTransportResult["errorCode"] {
  if (status === 400) {
    const normalizedBody = body.toLowerCase();
    if (
      normalizedBody.includes("moderation_blocked") ||
      normalizedBody.includes("safety_violations") ||
      normalizedBody.includes("safety system") ||
      normalizedBody.includes("content policy")
    ) {
      return "content_policy_blocked";
    }
  }
  return mapMediaVendorHttpStatus(status);
}
