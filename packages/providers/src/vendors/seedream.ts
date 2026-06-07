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

const MAX_MEDIA_VENDOR_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_LIVE_MEDIA_VENDOR_TIMEOUT_MS = 180_000;

export async function executeSeedreamImageGeneration(
  request: MediaVendorTransportRequest,
  options: LiveMediaVendorTransportOptions,
): Promise<MediaVendorTransportResult> {
  const endpoint = `${options.baseUrl?.replace(/\/+$/, "")}/images/generations`;
  const payload = buildSeedreamImageGenerationPayload(request.requestPlan);
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
      return await normalizeSeedreamHttpFailure(response, options.apiKey);
    }

    const json = await response.json();
    const imageUrls = extractSeedreamImageUrls(json);
    if (imageUrls.length === 0) {
      return {
        status: "failed",
        errorCode: "invalid_request",
        errorMessage: "Seedream image generation response did not include image URL data.",
      };
    }
    const imageArtifacts = await downloadSeedreamImageArtifacts(imageUrls, httpClient, abortController.signal);

    return {
      status: "succeeded",
      artifacts: [
        {
          type: "json",
          title: "Seedream image_generate response",
          contentType: "application/json; charset=utf-8",
          pathHint: "seedream-image-response.json",
          content: JSON.stringify(redactSecrets({
            mode: "live_seedream_image_generate",
            vendor: request.vendor.kind,
            operation: request.requestPlan.operation,
            endpoint,
            imageCount: imageUrls.length,
            request: payload,
            response: json,
          }, [options.apiKey]), null, 2),
        },
        ...imageArtifacts,
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

async function normalizeSeedreamHttpFailure(response: MediaVendorHttpResponse, apiKey: string | undefined): Promise<MediaVendorTransportResult> {
  const body = await readHttpResponseBody(response);
  const redactedBody = redactSecretText(body, [apiKey]);
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
