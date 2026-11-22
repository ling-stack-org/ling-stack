import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  DEVICE_CONTRACT_MAJOR_V1, DEVICE_TRANSPORTS_V1, type DeviceTransportV1, type EdgeRuntimeEnrollmentV1,
} from "@ling-stack/contracts";
import { DeviceFabricError } from "@ling-stack/core";
import { edgeRuntimeEnrollmentProofBytes } from "@ling-stack/remote-protocol";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const enrollmentGrantLifetimeMs = 5 * 60_000;

export async function handleEdgeRuntimeRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const path = /^\/v1\/device-support\/fabric\/edge-runtimes(?:\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/(enrollment|enrollment\/proof|revocation))?$/u.exec(url.pathname);
  if (!path) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const [, runtimeId, operation] = path;
  const method = operation === "revocation" ? "PUT" : operation ? "POST" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const store = runtime.fabricStore;
  try {
    if (runtimeId === undefined) {
      writePrivateJson(response, 200, {
        generatedAt: runtime.broker.now(), runtimes: runtime.edgeRuntimes.list().map(publicRuntime),
      });
      return true;
    }
    const body = await readJsonBody(request, 4096).catch(() => undefined);
    const now = runtime.broker.now();
    if (operation === "enrollment") {
      const enrollment = parseEnrollment(body);
      if (enrollment) {
        const { publicKeySpki, ...fields } = enrollment;
        const digest = createHash("sha256").update(Buffer.from(publicKeySpki, "base64url")).digest("hex");
        const grant = {
          ...fields, runtimeId, grantId: randomUUID(), publicKeyFingerprint: `sha256:${digest}`,
          expiresAt: new Date(Date.parse(now) + enrollmentGrantLifetimeMs).toISOString(),
        };
        store.issueEdgeRuntimeGrant(grant, publicKeySpki, now);
        writePrivateJson(response, 201, { grant });
        return true;
      }
    } else if (operation === "enrollment/proof") {
      if (isRecord(body) && Object.keys(body).length === 2 && isGrantId(body.grantId) && typeof body.signature === "string"
        && /^[A-Za-z0-9_-]{86}$/u.test(body.signature)) {
        const signature = Buffer.from(body.signature, "base64url");
        if (signature.toString("base64url") === body.signature) {
          const result = store.confirmEdgeRuntimeGrant(runtimeId, body.grantId, now, (grant, encodedKey) => {
            const key = readPublicKey(encodedKey);
            return key !== undefined && verify(null, edgeRuntimeEnrollmentProofBytes(grant), key, signature);
          });
          writePrivateJson(response, result.replayed ? 200 : 201, { runtime: publicRuntime(result.runtime), replayed: result.replayed });
          return true;
        }
      }
    } else if (isRecord(body) && Object.keys(body).length === 1) {
      if (isGrantId(body.grantId)) {
        store.cancelEdgeRuntimeGrant(runtimeId, body.grantId);
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        return true;
      }
      if (isRevision(body.expectedRevision) && body.expectedRevision > 0) {
        const revoked = store.revokeEdgeRuntimeEnrollment(runtimeId, body.expectedRevision);
        writePrivateJson(response, 200, { runtime: publicRuntime(revoked) });
        return true;
      }
    }
    writePrivateJson(response, 400, { error: "invalid_request" });
  } catch (error) {
    if (error instanceof DeviceFabricError) {
      const status = error.code === "target_missing" ? 404 : error.code === "safety_denied" ? 403 : 409;
      writePrivateJson(response, status, { error: error.code });
    } else {
      writePrivateJson(response, 503, { error: "service_unavailable" });
    }
  }
  return true;
}

function parseEnrollment(body: unknown) {
  if (!isRecord(body) || Object.keys(body).length !== 5) return undefined;
  const { displayName, contractMajor, supportedTransports, publicKeySpki, expectedRevision } = body;
  if (typeof displayName !== "string" || !displayName || displayName.trim() !== displayName
    || Buffer.byteLength(displayName) > 128 || /[\u0000-\u001f\u007f]/u.test(displayName)
    || contractMajor !== DEVICE_CONTRACT_MAJOR_V1 || !isRevision(expectedRevision)
    || !Array.isArray(supportedTransports) || supportedTransports.length === 0
    || !supportedTransports.every((value): value is DeviceTransportV1 => DEVICE_TRANSPORTS_V1.includes(value))
    || new Set(supportedTransports).size !== supportedTransports.length
    || typeof publicKeySpki !== "string" || !readPublicKey(publicKeySpki)) return undefined;
  return { displayName, contractMajor, supportedTransports, publicKeySpki, expectedRevision };
}

function readPublicKey(encoded: string): KeyObject | undefined {
  if (!/^[A-Za-z0-9_-]{59}$/u.test(encoded)) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).toString("base64url") === encoded
      ? key : undefined;
  } catch {
    return undefined;
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function isGrantId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function publicRuntime({ runtimeId, displayName, contractMajor, supportedTransports, status, revision, lastSeenAt }: EdgeRuntimeEnrollmentV1) {
  return { runtimeId, displayName, contractMajor, supportedTransports, status, revision, lastSeenAt };
}
