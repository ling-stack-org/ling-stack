import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  DEVICE_CONTRACT_MAJOR_V1, DEVICE_TRANSPORTS_V1, EDGE_LOCAL_NETWORK_CAPABILITY_ID, type DeviceTaskGraphNodeReceiptV1, type DeviceTransportV1,
  type EdgeRuntimeEnrollmentV1, type EdgeRuntimeHealthSampleV1,
} from "@ling-stack/contracts";
import { assertEdgeRuntimeJournalEntry, DeviceFabricError, DeviceTaskGraphCoordinator } from "@ling-stack/core";
import {
  edgeRuntimeDiagnosisClaimBytes, edgeRuntimeEnrollmentProofBytes, edgeRuntimeHealthSampleBytes, edgeRuntimeJournalEntryBytes, edgeRuntimeTaskGraphReceiptBytes,
  isEdgeTaskGraphReceipt, type EdgeRuntimeEvidenceBindingV1, type EdgeRuntimeKeyBindingV1,
} from "@ling-stack/remote-protocol";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import {
  claimEdgeDiagnosis, isEdgeDiagnosisId, queueEdgeDiagnosis, readEdgeDiagnosis, readEdgeDiagnosisConformance, readEdgeDiagnosisEvents, stopEdgeDiagnosis,
} from "./edge-work.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const enrollmentGrantLifetimeMs = 5 * 60_000;

export async function handleEdgeRuntimeRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const path = /^\/v1\/device-support\/fabric\/edge-runtimes(?:\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/(enrollment|enrollment\/proof|revocation|health\/events|diagnoses)(?:\/(edge_diagnosis_[0-9a-f]{64})(?:\/(events|conformance|stop))?)?)?$/u.exec(url.pathname);
  if (!path) return false;
  const [, runtimeId, operation, diagnosisId, projection] = path;
  if (diagnosisId !== undefined && operation !== "diagnoses") return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const method = operation === "revocation" || projection === "stop" ? "PUT"
    : operation && operation !== "health/events" && !diagnosisId ? "POST" : "GET";
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
    if (operation === "health/events") {
      const cursor = readEdgeJournalCursor(url.searchParams);
      if (!cursor) writePrivateJson(response, 400, { error: "invalid_request" });
      else writePrivateJson(response, 200, store.readEdgeRuntimeHealthPage({ ...cursor, runtimeId, now: runtime.broker.now() }));
      return true;
    }
    if (diagnosisId !== undefined) {
      if (projection === "events") {
        const cursor = readEdgeJournalCursor(url.searchParams);
        if (!cursor) writePrivateJson(response, 400, { error: "invalid_request" });
        else writePrivateJson(response, 200, readEdgeDiagnosisEvents(runtime, runtimeId, diagnosisId, cursor));
      } else if (projection === "conformance") {
        writePrivateJson(response, 200, readEdgeDiagnosisConformance(runtime, runtimeId, diagnosisId));
      } else if (projection === "stop") {
        const body = await readJsonBody(request, 4096).catch(() => undefined);
        if (url.search || !isRecord(body) || Object.keys(body).length !== 1 || !isRevision(body.expectedRevision) || body.expectedRevision < 1) {
          writePrivateJson(response, 400, { error: "invalid_request" });
        } else {
          writePrivateJson(response, 200, { graph: stopEdgeDiagnosis(runtime, runtimeId, diagnosisId, body.expectedRevision) });
        }
      } else {
        writePrivateJson(response, 200, readEdgeDiagnosis(runtime, runtimeId, diagnosisId));
      }
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
    } else if (operation === "diagnoses") {
      if (isRecord(body) && Object.keys(body).length === 2 && isRevision(body.expectedRevision) && body.expectedRevision >= 1
        && typeof body.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(body.requestId)) {
        const result = queueEdgeDiagnosis(runtime, runtimeId, body.expectedRevision, body.requestId);
        writePrivateJson(response, result.replayed ? 200 : 201, result);
        return true;
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
    writeEdgeRuntimeError(response, error);
  }
  return true;
}

function readEdgeJournalCursor(params: URLSearchParams) {
  const defaults: { generation?: number; afterSequence: number; limit: number } = { generation: undefined, afterSequence: 0, limit: 50 };
  for (const [key, value] of params) {
    if (!Object.hasOwn(defaults, key) || params.getAll(key).length !== 1 || !/^\d+$/u.test(value)) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) return undefined;
    defaults[key as keyof typeof defaults] = number;
  }
  return (defaults.generation === undefined || defaults.generation >= 1) && defaults.limit >= 1 && defaults.limit <= 100 ? defaults : undefined;
}

export async function handleSignedEdgeEvidenceRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const path = /^\/v1\/device-support\/fabric\/edge-runtimes\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/(diagnosis-claim|journal|task-graph-receipt|health)$/u.exec(url.pathname);
  if (!path) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  const runtimeId = path[1]!;
  const body = await readJsonBody(request, 4096).catch(() => undefined);
  if (path[2] === "health") {
    if (url.search) writePrivateJson(response, 400, { error: "invalid_request" });
    else writeEdgeHealthAdmission(runtime, runtimeId, body, response);
    return true;
  }
  const envelope = readEvidenceEnvelope(body);
  if (!envelope || url.search) {
    writePrivateJson(response, 400, { error: "invalid_request" });
    return true;
  }
  const { binding, payload, signature } = envelope;
  const store = runtime.fabricStore;
  try {
    if (path[2] === "diagnosis-claim") {
      if (!isRecord(payload) || Object.keys(payload).length !== 1 || !isEdgeDiagnosisId(payload.graphId)) {
        writePrivateJson(response, 400, { error: "invalid_request" });
        return true;
      }
      const bytes = edgeRuntimeDiagnosisClaimBytes(binding, payload.graphId);
      const authorize = () => verifyEdgeEvidence(runtime, runtimeId, binding, bytes, signature);
      authorize();
      writePrivateJson(response, 200, claimEdgeDiagnosis(runtime, payload.graphId, runtimeId, binding, authorize));
      return true;
    }
    if (path[2] === "journal") {
      try {
        assertEdgeRuntimeJournalEntry(payload);
      } catch {
        writePrivateJson(response, 400, { error: "invalid_request" });
        return true;
      }
      if (payload.runtimeId !== runtimeId) throw new DeviceFabricError("safety_denied", "edge journal entry targets another runtime");
      const bytes = edgeRuntimeJournalEntryBytes(binding, payload);
      const saved = store.appendEdgeRuntimeJournalEntry(payload, () => {
        verifyEdgeEvidence(runtime, runtimeId, binding, bytes, signature);
        const { graph, node } = boundEdgeGraph(runtime, runtimeId, binding, payload.ownerTaskId, payload.operationId);
        const diagnosis = node.capabilityId === EDGE_LOCAL_NETWORK_CAPABILITY_ID;
        const phaseAllowed = payload.sequence === 1 && payload.kind === "task_started"
          || payload.sequence === 2 && ["task_completed", "task_failed", "task_unknown"].includes(payload.kind);
        if ((payload.networkObservation && !diagnosis) || (diagnosis && (!phaseAllowed
          || payload.entryId !== `${payload.operationId}:${payload.sequence}` || (payload.kind === "task_completed" && !payload.networkObservation)))) {
          throw new DeviceFabricError("safety_denied", "edge observation is outside the dispatched capability");
        }
        if (diagnosis && graph.cancellationRequestedAt && !store.getEdgeRuntimeJournalEntry(runtimeId, payload.ownerTaskId, payload.operationId + ":1")) {
          throw new DeviceFabricError("safety_denied", "edge diagnosis stopped before journal start");
        }
      });
      writePrivateJson(response, saved.replayed ? 200 : 201, saved);
      return true;
    }

    if (!isEdgeTaskGraphReceipt(payload)) {
      writePrivateJson(response, 400, { error: "invalid_request" });
      return true;
    }
    if (payload.ownerId !== runtimeId || payload.routeGeneration !== binding.runtimeRevision) {
      throw new DeviceFabricError("safety_denied", "edge receipt targets another runtime or route");
    }
    const bytes = edgeRuntimeTaskGraphReceiptBytes(binding, payload);
    verifyEdgeEvidence(runtime, runtimeId, binding, bytes, signature);
    const { graph, node } = boundEdgeGraph(runtime, runtimeId, binding, payload.graphId, payload.attemptId);
    if (node.nodeId !== payload.nodeId || (node.attemptGraphRevision !== undefined && node.attemptGraphRevision !== payload.graphRevision)) {
      throw new DeviceFabricError("safety_denied", "edge receipt is outside its node or dispatch revision");
    }
    const coordinator = new DeviceTaskGraphCoordinator({ persistence: store, now: runtime.broker.now });
    const settled = coordinator.recordNodeReceipt(graph, payload, {
      ownerKind: "edge", ownerId: runtimeId, routeGeneration: binding.runtimeRevision,
    }, () => {
      verifyEdgeEvidence(runtime, runtimeId, binding, bytes, signature);
      boundEdgeGraph(runtime, runtimeId, binding, payload.graphId, payload.attemptId);
      const entry = store.getEdgeRuntimeJournalEntry(runtimeId, payload.graphId, payload.resultRef);
      if (!entry || entry.operationId !== payload.attemptId || entry.outcome !== journalOutcome[payload.status]
        || (payload.status === "succeeded" && !entry.payloadDigest)) {
        throw new DeviceFabricError("safety_denied", "edge receipt requires matching journal evidence");
      }
    });
    writePrivateJson(response, 200, { graphId: settled.graphId, revision: settled.revision, nodeId: node.nodeId,
      status: settled.nodes.find(item => item.nodeId === node.nodeId)?.status });
  } catch (error) {
    writeEdgeRuntimeError(response, error);
  }
  return true;
}

const journalOutcome: Record<DeviceTaskGraphNodeReceiptV1["status"], string> = {
  succeeded: "completed", failed: "failed", unknown: "unknown", cancelled: "cancelled",
};

function boundEdgeGraph(runtime: DeviceSupportRuntime, runtimeId: string, binding: EdgeRuntimeEvidenceBindingV1, graphId: string, attemptId: string) {
  const placement = runtime.fabricStore.getEdgeRuntimePlacementDecision(binding.placementId);
  if (placement?.mode !== "local" || placement.runtimeId !== runtimeId || placement.runtimeRevision !== binding.runtimeRevision
    || placement.ownerTaskId !== graphId) {
    throw new DeviceFabricError("safety_denied", "edge evidence is outside its placement");
  }
  const graph = runtime.fabricStore.getTaskGraph(graphId);
  const node = graph?.nodes.find(item => item.ownerKind === "edge" && item.ownerId === runtimeId && item.attemptId === attemptId
    && item.ownerRouteGeneration === binding.runtimeRevision && item.targetDeviceId === placement.targetDeviceId
    && item.capabilityId === placement.capabilityId);
  if (!graph || !node) throw new DeviceFabricError("safety_denied", "edge evidence is outside its dispatched attempt");
  return { graph, node };
}

function verifyEdgeEvidence(
  runtime: DeviceSupportRuntime, runtimeId: string, binding: EdgeRuntimeKeyBindingV1, bytes: Uint8Array, signature: Buffer,
): void {
  const store = runtime.fabricStore;
  const enrolled = store.getEdgeRuntime(runtimeId);
  const encodedKey = enrolled?.status === "enrolled" && enrolled.revision === binding.runtimeRevision
    ? store.getEdgeRuntimePublicKey(runtimeId, binding.runtimeRevision, binding.grantId)
    : undefined;
  const key = encodedKey && readPublicKey(encodedKey);
  if (!key || !verify(null, bytes, key, signature)) throw new DeviceFabricError("safety_denied", "edge runtime evidence is unauthorized");
}

function readEvidenceEnvelope(body: unknown): { binding: EdgeRuntimeEvidenceBindingV1; payload: unknown; signature: Buffer } | undefined {
  const envelope = readSignedEdgeEnvelope(body, 3);
  if (!envelope || typeof envelope.placementId !== "string" || !/^edge_placement_[0-9a-f]{64}$/u.test(envelope.placementId)) return undefined;
  return { binding: { ...envelope.binding, placementId: envelope.placementId }, payload: envelope.payload, signature: envelope.signature };
}

function readSignedEdgeEnvelope(body: unknown, bindingFieldCount: number) {
  if (!isRecord(body) || Object.keys(body).length !== 3 || !isRecord(body.binding) || Object.keys(body.binding).length !== bindingFieldCount) return undefined;
  const { grantId, runtimeRevision, placementId } = body.binding;
  if (!isGrantId(grantId) || !isRevision(runtimeRevision) || runtimeRevision < 1 || typeof body.signature !== "string"
    || !/^[A-Za-z0-9_-]{86}$/u.test(body.signature) || !Object.hasOwn(body, "payload")) return undefined;
  const signature = Buffer.from(body.signature, "base64url");
  if (signature.toString("base64url") !== body.signature) return undefined;
  return { binding: { grantId, runtimeRevision }, placementId, payload: body.payload, signature };
}

function writeEdgeHealthAdmission(runtime: DeviceSupportRuntime, runtimeId: string, body: unknown, response: ServerResponse): void {
  const envelope = readSignedEdgeEnvelope(body, 2);
  const payload = envelope?.payload;
  if (!envelope || !isRecord(payload) || Object.keys(payload).length !== 3
    || typeof payload.sampleId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(payload.sampleId)
    || typeof payload.connected !== "boolean" || typeof payload.observedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(payload.observedAt)
    || !Number.isFinite(Date.parse(payload.observedAt))) {
    writePrivateJson(response, 400, { error: "invalid_request" });
    return;
  }
  const sample: EdgeRuntimeHealthSampleV1 = { sampleId: payload.sampleId, observedAt: payload.observedAt, connected: payload.connected };
  const { binding, signature } = envelope;
  const bytes = edgeRuntimeHealthSampleBytes(runtimeId, binding, sample);
  try {
    const result = runtime.fabricStore.recordEdgeRuntimeHealth({
      runtimeId, runtimeRevision: binding.runtimeRevision, sample, now: runtime.broker.now(),
      authorize: () => verifyEdgeEvidence(runtime, runtimeId, binding, bytes, signature),
    });
    writePrivateJson(response, result.status === "accepted" && !result.replayed ? 201 : 200, result);
  } catch (error) {
    writeEdgeRuntimeError(response, error);
  }
}

function writeEdgeRuntimeError(response: ServerResponse, error: unknown): void {
  if (error instanceof DeviceFabricError) {
    const status = error.code === "target_missing" ? 404 : error.code === "safety_denied" ? 403 : 409;
    writePrivateJson(response, status, { error: error.code });
  } else {
    writePrivateJson(response, 503, { error: "service_unavailable" });
  }
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
