import type { IncomingMessage, ServerResponse } from "node:http";
import type { UpdateUserProfileInput } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

const MAX_AVATAR_DATA_URL_LENGTH = 256 * 1024;

export async function handleUserProfile(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const now = new Date().toISOString();
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, profile: store.getUserProfile(now) });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const profile = store.updateUserProfile(parseUserProfileUpdate(body), now);
      writeJson(response, 200, { cwd, profile });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for profile` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseUserProfileUpdate(value: unknown): UpdateUserProfileInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be an object.");
  }
  const record = value as Record<string, unknown>;
  return {
    displayName: readOptionalString(record, "displayName"),
    handle: readOptionalNullableString(record, "handle"),
    avatarDataUrl: readOptionalAvatarDataUrl(record, "avatarDataUrl"),
  };
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string.`);
  }
  return value;
}

function readOptionalNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null.`);
  }
  return value;
}

function readOptionalAvatarDataUrl(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = readOptionalNullableString(record, key);
  if (value === undefined || value === null) {
    return value;
  }
  if (value.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new Error("avatarDataUrl is too large.");
  }
  if (!/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error("avatarDataUrl must be a base64 image data URL.");
  }
  return value;
}
