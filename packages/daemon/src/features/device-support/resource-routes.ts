import type { IncomingMessage, ServerResponse } from "node:http";

import { isDeviceResourceManifestV1 } from "@ling-stack/contracts";
import { DeviceFabricError, type DeviceResourceCompatibility } from "@ling-stack/core";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const maxPayloadBytes = 4 * 1024 * 1024;
const maxImportBodyBytes = 6 * 1024 * 1024;
const resourcePlatforms: Partial<Record<NodeJS.Platform, DeviceResourceCompatibility["platform"]>> = {
  darwin: "macos", linux: "linux", win32: "windows",
};

export async function handleDeviceResourceRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const resourcePath = /^\/v1\/device-support\/resources(?:\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(?:\/(rollback|disable))?)?$/u.exec(url.pathname);
  if (!resourcePath) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const [, resourceId, action] = resourcePath;
  const method = resourceId && !action ? "GET" : "POST";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!runtime.resourceTrustConfigured) {
    writePrivateJson(response, 503, { error: "resource_trust_unavailable" });
    return true;
  }
  const store = runtime.fabricStore;
  const compatibility: DeviceResourceCompatibility = { platform: resourcePlatforms[process.platform] };
  try {
    if (resourceId === undefined) {
      const body = await readJsonBody(request, maxImportBodyBytes).catch(() => undefined);
      const resource = parseResourceImport(body);
      if (!resource) {
        writePrivateJson(response, 400, { error: "invalid_resource_import" });
        return true;
      }
      const result = store.installResource(resource.manifest, resource.payload, undefined, compatibility);
      writePrivateJson(response, result.replayed ? 200 : 201, result);
    } else if (action === "rollback") {
      writePrivateJson(response, 200, { record: store.rollbackResource(resourceId, compatibility) });
    } else if (action === "disable") {
      store.setResourceStatus(resourceId, "disabled", "disabled by operator");
      writePrivateJson(response, 200, { record: store.getResource(resourceId) });
    } else {
      const record = store.getResource(resourceId);
      writePrivateJson(response, record ? 200 : 404, record ? { record } : { error: "target_missing" });
    }
  } catch (error) {
    if (error instanceof DeviceFabricError) {
      writePrivateJson(response, error.code === "target_missing" ? 404 : 409, { error: error.code, message: error.message });
    } else {
      writePrivateJson(response, 503, { error: "service_unavailable" });
    }
  }
  return true;
}

function parseResourceImport(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return undefined;
  const { manifest, payloadBase64Url } = value as Record<string, unknown>;
  if (!isDeviceResourceManifestV1(manifest) || typeof payloadBase64Url !== "string" || !payloadBase64Url) return undefined;
  const payload = Buffer.from(payloadBase64Url, "base64url");
  if (payload.byteLength > maxPayloadBytes || payload.toString("base64url") !== payloadBase64Url) return undefined;
  return { manifest, payload };
}
