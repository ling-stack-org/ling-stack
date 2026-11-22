import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { DeviceDeveloperJobV1, DeviceDeveloperSessionV1, HardwareProtocolCaptureV1 } from "@ling-stack/contracts";
import { DEFAULT_WORKSPACE_ID, DeviceFabricError } from "@ling-stack/core";
import { canonicalJsonBytes } from "@ling-stack/remote-protocol";
import { allowLocalServiceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writePrivateJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import type { DeviceSupportRuntime } from "./runtime.js";

const protocolPath = "/v1/device-support/protocol";
const sessionOperationPath = /^\/v1\/device-support\/protocol\/sessions\/([A-Za-z0-9_-]+)\/(replay|capture)$/u;
type ReplaySession = DeviceDeveloperSessionV1 & Required<Pick<DeviceDeveloperSessionV1, "protocolReplay">>;

export async function handleDeviceProtocolRoute(
  url: URL, request: IncomingMessage, response: ServerResponse, runtime: DeviceSupportRuntime,
): Promise<boolean> {
  const profiles = url.pathname === `${protocolPath}/profiles`;
  const transports = url.pathname === `${protocolPath}/transports`;
  const createSession = url.pathname === `${protocolPath}/sessions`;
  const [, sessionId, operation] = sessionOperationPath.exec(url.pathname) ?? [];
  if (!profiles && !transports && !createSession && !sessionId) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  const method = request.method;
  if (profiles || transports ? method !== "GET" : createSession ? method !== "POST" : method !== "GET" && method !== "POST") {
    response.setHeader("Allow", profiles || transports ? "GET" : createSession ? "POST" : "GET, POST");
    writePrivateJson(response, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    if (profiles) {
      writePrivateJson(response, 200, { profiles: runtime.protocolProfiles.list() });
      return true;
    }
    if (transports) {
      const visible = runtime.protocolTransports.list().flatMap(({ transportId, targetDeviceId, transport }) => {
        const target = runtime.store.getDevice(targetDeviceId);
        if (target?.device.ownerScope !== DEFAULT_WORKSPACE_ID
          || ["offline", "retired", "revoked"].includes(target.device.lifecycleStatus)) return [];
        return [{ transportId, targetDeviceId, transport, displayName: target.device.displayName }];
      });
      writePrivateJson(response, 200, { transports: visible });
      return true;
    }
    if (createSession) {
      const body = await readJsonBody(request, 4096).catch(() => undefined);
      if (!isRecord(body) || Object.keys(body).some(key => !["profileId", "targetDeviceId", "transportId"].includes(key))
        || !isProtocolId(body.profileId) || !isProtocolId(body.targetDeviceId)
        || (body.transportId !== undefined && !isProtocolId(body.transportId))) {
        writePrivateJson(response, 400, { error: "invalid_protocol_session" });
        return true;
      }
      const profile = runtime.store.getDevice(body.targetDeviceId);
      if (profile && profile.device.ownerScope !== DEFAULT_WORKSPACE_ID) {
        throw new DeviceFabricError("target_missing", "protocol target is outside the current workspace");
      }
      const protocol = runtime.protocolProfiles.resolve({
        profileId: body.profileId, deviceKind: profile?.device.kind ?? "hardware",
        model: profile?.device.model, firmwareVersion: profile?.device.firmwareVersion,
      });
      const codec = runtime.protocolWorkbench.getCodecManifest(protocol.codecId);
      if (!codec) throw new DeviceFabricError("target_missing", "protocol codec is unavailable");
      const transport = body.transportId === undefined ? undefined : runtime.protocolTransports.get(body.transportId);
      if (body.transportId !== undefined && (!transport || !profile || transport.targetDeviceId !== profile.device.id
        || protocol.transport !== transport.transport || !profile.transports.includes(transport.transport)
        || ["offline", "retired", "revoked"].includes(profile.device.lifecycleStatus))) {
        throw new DeviceFabricError("target_missing", "live transport is unavailable for the selected target");
      }
      const now = new Date().toISOString();
      const session = runtime.developerSessions.createSession({
        sessionId: `protocol_replay_${randomUUID()}`, workspaceId: DEFAULT_WORKSPACE_ID,
        ownerKind: "daemon", ownerId: DEFAULT_WORKSPACE_ID, targetDeviceId: body.targetDeviceId,
        targetKind: profile?.device.kind ?? "hardware", mode: "developer", status: "authorized",
        authorizationRevision: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
        protocolReplay: {
          profileId: protocol.profileId, profileVersion: protocol.version, codecId: codec.codecId, codecVersion: codec.version,
          ...(transport && profile ? { liveTransport: {
            transportId: transport.transportId, connectionRevision: transport.connectionRevision,
            targetProfileRevision: profile.profileRevision,
          } } : {}),
        },
      });
      writePrivateJson(response, 201, { session });
      return true;
    }
    const session = requireReplaySession(runtime, sessionId!);
    if (session.protocolReplay.liveTransport ? operation !== "capture" : operation !== "replay") {
      throw new DeviceFabricError("target_missing", "this protocol operation is unavailable in the session");
    }
    const jobId = `workbench:${session.sessionId}`;
    if (method === "GET") {
      const job = runtime.developerSessions.getJob(jobId);
      writePrivateJson(response, 200, readCompletedReplay(runtime, session, job));
      return true;
    }

    if (session.protocolReplay.liveTransport) {
      await handleLiveCapture(runtime, session, jobId, request, response);
      return true;
    }
    const body = await readJsonBody(request, 1024 * 1024).catch(() => undefined);
    if (!isRecord(body) || Object.keys(body).length !== 2 || typeof body.authorizationRevision !== "string" || !isImportedCapture(body.capture)) {
      writePrivateJson(response, 400, { error: "invalid_protocol_capture" });
      return true;
    }
    const active = requireReplaySession(runtime, session.sessionId);
    if (body.authorizationRevision !== active.authorizationRevision) {
      throw new DeviceFabricError("safety_denied", "protocol replay session authorization changed");
    }
    const capture = { ...body.capture, captureId: `${session.sessionId}:${body.capture.captureId}` };
    const replay = decodeReplay(runtime, active, capture);
    const artifactDigest = captureDigest(capture);
    const now = new Date().toISOString();
    const existing = runtime.developerSessions.getJob(jobId);
    const started = runtime.developerSessions.startJob({
      jobId, sessionId: active.sessionId, kind: "workbench", status: "running", targetDeviceId: active.targetDeviceId,
      taskStatus: "executing", artifactDigest, revision: 1, updatedAt: now,
      ...(!existing || existing.authorizationRevision !== undefined ? { authorizationRevision: active.authorizationRevision } : {}),
    });
    if (started.status === "completed" && started.outputRef === capture.captureId) {
      writePrivateJson(response, 200, readCompletedReplay(runtime, active, started));
      return true;
    }
    if (started.status !== "running") throw new DeviceFabricError("revision_conflict", "protocol replay job already has an outcome");
    runtime.protocolStore.saveCapture(capture);
    const job = runtime.developerSessions.settleJob(jobId, "completed", capture.captureId, now, "succeeded");
    writePrivateJson(response, 201, { job, replay });
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

function requireReplaySession(runtime: DeviceSupportRuntime, sessionId: string): ReplaySession {
  const session = runtime.developerSessions.getSession(sessionId);
  if (!session?.protocolReplay || session.workspaceId !== DEFAULT_WORKSPACE_ID
    || session.ownerKind !== "daemon" || session.mode !== "developer") {
    throw new DeviceFabricError("target_missing", "developer protocol replay session is unavailable");
  }
  if (session.protocolReplay.liveTransport && runtime.store.getDevice(session.targetDeviceId)?.device.ownerScope !== session.workspaceId) {
    throw new DeviceFabricError("target_missing", "protocol target is outside the current workspace");
  }
  if (session.status === "revoked") throw new DeviceFabricError("safety_denied", "developer protocol replay session was revoked");
  return { ...session, protocolReplay: session.protocolReplay };
}

function readCompletedReplay(runtime: DeviceSupportRuntime, session: ReplaySession, job: DeviceDeveloperJobV1 | undefined) {
  if (job?.status !== "completed" || job.sessionId !== session.sessionId || job.kind !== "workbench" || !job.outputRef) {
    throw new DeviceFabricError("target_missing", "protocol replay is unavailable");
  }
  const capture = runtime.protocolStore.getCapture(job.outputRef);
  if (!capture) throw new DeviceFabricError("target_missing", "protocol replay capture is unavailable");
  if (captureDigest(capture) !== (session.protocolReplay.liveTransport ? job.outputDigest : job.artifactDigest)) {
    throw new DeviceFabricError("revision_conflict", "protocol replay capture digest changed");
  }
  return { job, replay: decodeReplay(runtime, session, capture) };
}

function captureDigest(capture: HardwareProtocolCaptureV1): string {
  return createHash("sha256").update(canonicalJsonBytes(capture)).digest("hex");
}

function decodeReplay(
  runtime: DeviceSupportRuntime, session: ReplaySession,
  capture: HardwareProtocolCaptureV1,
) {
  const binding = session.protocolReplay;
  const profile = runtime.protocolStore.getProfile(binding.profileId);
  const codec = runtime.protocolWorkbench.getCodecManifest(binding.codecId);
  if (!profile || !codec || profile.version !== binding.profileVersion || codec.version !== binding.codecVersion || profile.codecId !== codec.codecId
    || capture.transport !== profile.transport || capture.targetDeviceId !== session.targetDeviceId
    || capture.source !== (binding.liveTransport ? "live" : "imported")) {
    throw new DeviceFabricError("target_changed", "protocol replay target, profile or codec changed");
  }
  const decoded = runtime.protocolWorkbench.decode(capture, codec.codecId);
  return {
    captureId: capture.captureId, targetDeviceId: capture.targetDeviceId, transport: capture.transport,
    createdAt: capture.createdAt, source: capture.source, ...binding, ...(capture.loss ? { loss: capture.loss } : {}),
    frames: decoded.map((frame, index) => ({
      ...frame, capturedAt: capture.frames[index]!.capturedAt, direction: capture.frames[index]!.direction,
      digest: capture.frames[index]!.digest,
    })),
  };
}

async function handleLiveCapture(
  runtime: DeviceSupportRuntime, session: ReplaySession, jobId: string, request: IncomingMessage, response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request, 4096).catch(() => undefined);
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.authorizationRevision !== "string") {
    writePrivateJson(response, 400, { error: "invalid_protocol_capture" });
    return;
  }
  const active = requireReplaySession(runtime, session.sessionId);
  if (body.authorizationRevision !== active.authorizationRevision) {
    throw new DeviceFabricError("safety_denied", "protocol capture session authorization changed");
  }
  const previous = runtime.developerSessions.getJob(jobId);
  if (previous?.status === "completed") {
    writePrivateJson(response, 200, readCompletedReplay(runtime, active, previous));
    return;
  }
  if (previous) throw new DeviceFabricError("revision_conflict", "protocol capture already has a dispatch record");
  const binding = active.protocolReplay.liveTransport!;
  const target = runtime.store.getDevice(active.targetDeviceId);
  const transport = runtime.protocolTransports.get(binding.transportId);
  if (!target || target.profileRevision !== binding.targetProfileRevision
    || ["offline", "revoked", "retired"].includes(target.device.lifecycleStatus)
    || transport?.connectionRevision !== binding.connectionRevision || transport.targetDeviceId !== target.device.id) {
    throw new DeviceFabricError("target_changed", "live capture target or connection changed");
  }
  const now = new Date().toISOString();
  runtime.developerSessions.startJob({
    jobId, sessionId: active.sessionId, kind: "workbench", status: "running", targetDeviceId: active.targetDeviceId,
    taskStatus: "executing", authorizationRevision: active.authorizationRevision, revision: 1, updatedAt: now,
  });
  const stop = new AbortController();
  const onClose = () => stop.abort();
  response.once("close", onClose);
  let result: ReturnType<typeof readCompletedReplay>;
  try {
    const capture = await runtime.protocolTransports.capture({
      captureId: `live:${active.sessionId}`, targetDeviceId: target.device.id, transportId: binding.transportId,
      createdAt: now, durationMs: 10_000, maxFrames: 256, signal: stop.signal,
    });
    const current = requireReplaySession(runtime, session.sessionId);
    const currentTarget = runtime.store.getDevice(target.device.id);
    if (current.authorizationRevision !== active.authorizationRevision
      || currentTarget?.profileRevision !== binding.targetProfileRevision
      || ["offline", "revoked", "retired"].includes(currentTarget.device.lifecycleStatus)) {
      throw new DeviceFabricError("target_changed", "protocol capture authority changed");
    }
    const replay = decodeReplay(runtime, active, capture);
    runtime.protocolStore.saveCapture(capture);
    const taskStatus = capture.loss ? (capture.frames.length ? "partial" : "unknown") : "succeeded";
    const job = runtime.developerSessions.settleJob(jobId, "completed", capture.captureId, new Date().toISOString(), taskStatus, captureDigest(capture));
    result = { job, replay };
  } catch (error) {
    runtime.developerSessions.settleJob(jobId, "unknown", undefined, new Date().toISOString(), "unknown");
    throw error;
  } finally {
    response.off("close", onClose);
  }
  writePrivateJson(response, 201, result);
}

function isProtocolId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u.test(value);
}

function isImportedCapture(value: unknown): value is HardwareProtocolCaptureV1 {
  if (!isRecord(value) || !isProtocolId(value.captureId) || !isProtocolId(value.targetDeviceId)
    || value.source !== "imported" || typeof value.createdAt !== "string" || typeof value.transport !== "string"
    || Object.keys(value).some(key => !["captureId", "targetDeviceId", "createdAt", "source", "transport", "frames", "loss"].includes(key))
    || !Array.isArray(value.frames) || value.frames.length > 2048) return false;
  if (value.loss !== undefined && (!isRecord(value.loss) || typeof value.loss.reason !== "string"
    || Object.keys(value.loss).some(key => key !== "reason" && key !== "droppedFrames"))) return false;
  return value.frames.every(frame => isRecord(frame)
    && Object.keys(frame).length === 5 && typeof frame.sequence === "number" && typeof frame.direction === "string"
    && typeof frame.bytesBase64 === "string" && typeof frame.digest === "string" && typeof frame.capturedAt === "string");
}
