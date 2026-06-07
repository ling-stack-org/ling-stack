import type { MediaAdapterErrorCode, MediaVendorHttpClient, MediaVendorHttpRequestInit, MediaVendorHttpResponse } from "./types.js";

export async function defaultMediaVendorHttpClient(url: string, init: MediaVendorHttpRequestInit): Promise<MediaVendorHttpResponse> {
  return await fetch(url, init);
}

export async function readHttpResponseBody(response: MediaVendorHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function getMediaVendorResponseHeader(response: MediaVendorHttpResponse, name: string): string | undefined {
  return response.headers?.get(name) ?? response.headers?.get(name.toLowerCase()) ?? undefined;
}

export function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function mapMediaVendorHttpStatus(status: number): MediaAdapterErrorCode {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 404) {
    return "model_not_found";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 400 && status < 500) {
    return "invalid_request";
  }
  return "provider_internal_error";
}
