import { createHash } from "node:crypto";
import { redactSecrets } from "@ling-stack/core";
import { isDeepStrictEqual } from "node:util";
import type { HostMediaEffectKind, HostMediaProtocol, MediaRemoteTerminalObservation,
  MediaWorkflowOutputRule } from "@ling-stack/contracts";
import { decodeSeedanceTaskStatusResponse } from "@ling-stack/providers";
import type { MediaExecutionArtifact } from "@ling-stack/providers";
import type { HostMediaArtifactRemoteDescriptor } from "./artifact-collection-receipt.js";
import { assertHostMediaNativeTransport, type HostMediaHttpExchange,
  type HostMediaNativeTransport, type HostMediaWireRequest } from "./native-http-transport.js";
import { decodeComfyUiJobObservation, decodeComfyUiLegacyObservation } from "./workflows/comfyui-terminal-observation.js";

export interface MediaNativeObservationPlan {
  readonly protocol: HostMediaProtocol;
  readonly adapterId: string;
  readonly namespaceDigest: string;
  readonly normalizedBaseUrl: string;
  effectKind(request: Pick<HostMediaWireRequest, "method" | "routeDigest">): HostMediaEffectKind | undefined;
  statusRoute(externalOperationId: string): Readonly<{ url: string; routeDigest: string }>;
  statusRoutes(externalOperationId: string): readonly Readonly<{ url: string; routeDigest: string }>[];
}
export interface MediaNativeSubmissionObservation {
  readonly externalOperationId: string;
  readonly statusRouteUrl: string;
  readonly statusRouteDigest: string;
  readonly statusRouteDigests?: readonly string[];
}
export interface MediaNativeTerminalObservation {
  readonly observation: MediaRemoteTerminalObservation;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly videoUrl?: string;
}
export interface MediaNativeRemoteDescriptorMatcher {
  /** The exact native factory and its private issued exchange are both required. */
  capture(native: HostMediaNativeTransport, exchange: HostMediaHttpExchange): void;
  getRemoteDescriptor(candidate: MediaExecutionArtifact, index: number): HostMediaArtifactRemoteDescriptor | undefined;
}
interface PlanState {
  readonly protocol: HostMediaProtocol;
  readonly base: string;
  readonly forwardRoutes: ReadonlyMap<string, HostMediaEffectKind>;
  readonly outputRules: readonly MediaWorkflowOutputRule[];
}
interface DownloadPlan { readonly type: "image" | "video"; readonly pathHint?: string }
interface ByteSource extends DownloadPlan { readonly bytesSha256: string; readonly exchange: HostMediaHttpExchange }
const plans = new WeakMap<MediaNativeObservationPlan, PlanState>();
const protocols = ["image_response_v1", "seedance_task_v1", "comfy_jobs_v1", "comfy_prompt_legacy_v1"];

/** Freeze the effective namespace used by the existing Provider/Comfy URL builders, not caller recovery. */
export function createMediaNativeObservationPlan(input: {
  readonly protocol: HostMediaProtocol; readonly adapterId: string; readonly baseUrl: string;
  readonly outputRules?: readonly MediaWorkflowOutputRule[];
}): MediaNativeObservationPlan {
  if (!protocols.includes(input.protocol) || typeof input.adapterId !== "string" || !input.adapterId.trim()) {
    throw new Error("media_receipt_observation_plan_invalid");
  }
  const url = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("media_receipt_namespace_invalid");
  }
  // Comfy uses new URL('/api/...', base), which deliberately ignores a configured base path.
  const comfy = input.protocol.startsWith("comfy_");
  const base = comfy ? url.origin : url.href.replace(/\/+$/u, "");
  const outputRules = Object.freeze((input.outputRules ?? []).map(rule => {
    if (!rule || typeof rule.nodeId !== "string" || !rule.nodeId || !["image", "video"].includes(rule.artifactType)
      || !["first", "all"].includes(rule.collect)) throw new Error("media_receipt_output_rule_invalid");
    return Object.freeze({ nodeId: rule.nodeId, artifactType: rule.artifactType, collect: rule.collect });
  }));
  const forwardRoutes = new Map<string, HostMediaEffectKind>();
  if (input.protocol === "image_response_v1") forwardRoutes.set(sha(`${base}/images/generations`), "image_request");
  else if (input.protocol === "seedance_task_v1") forwardRoutes.set(sha(`${base}/contents/generations/tasks`), "remote_generation_submit");
  else {
    forwardRoutes.set(sha(`${base}/api/upload/image`), "comfy_image_upload");
    forwardRoutes.set(sha(`${base}/api/prompt`), "remote_generation_submit");
  }
  const state: PlanState = { protocol: input.protocol, base, forwardRoutes, outputRules };
  const plan: MediaNativeObservationPlan = Object.freeze({ protocol: input.protocol, adapterId: input.adapterId,
    normalizedBaseUrl: base, namespaceDigest: sha(base),
    effectKind: (request: Pick<HostMediaWireRequest, "method" | "routeDigest">) => {
      if (request.method === "GET" || request.method === "HEAD") return undefined;
      const kind = request.method === "POST" ? forwardRoutes.get(request.routeDigest) : undefined;
      if (!kind) throw new Error("media_receipt_forward_route_unrecognized");
      return kind;
    },
    statusRoute: (id: string) => statusRoute(state, id),
    statusRoutes: (id: string) => statusRoutes(state, id),
  });
  plans.set(plan, state);
  return plan;
}

/** Decode acknowledgements only from exact complete native response bytes and the fixed submit route. */
export function decodeMediaNativeSubmission(plan: MediaNativeObservationPlan, native: HostMediaNativeTransport,
  exchange: HostMediaHttpExchange): MediaNativeSubmissionObservation | undefined {
  assertActual(native, exchange);
  const state = requirePlan(plan);
  if (state.protocol === "image_response_v1" || exchange.request.method !== "POST" || !successful(exchange)
    || state.forwardRoutes.get(exchange.request.routeDigest) !== "remote_generation_submit") return undefined;
  const body = actualJson(native, exchange);
  if (!record(body)) return undefined;
  const ids = state.protocol === "seedance_task_v1"
    ? [body.id, record(body.data) ? body.data.id : undefined]
    : [body.prompt_id, body.id];
  const primary = state.protocol === "seedance_task_v1" ? ids.find(id => id !== undefined) : body.prompt_id;
  if (!validId(primary) || ids.some(id => id !== undefined && id !== primary)) return undefined;
  const route = statusRoute(state, primary);
  return Object.freeze({ externalOperationId: primary, statusRouteUrl: route.url, statusRouteDigest: route.routeDigest,
    ...(state.protocol === "comfy_prompt_legacy_v1"
      ? { statusRouteDigests: Object.freeze(statusRoutes(state, primary).map(item => item.routeDigest)) } : {}) });
}

/** A terminal needs its original exact GET route, identity and closed protocol decoder; output presence is separate. */
export function decodeMediaNativeTerminal(plan: MediaNativeObservationPlan, native: HostMediaNativeTransport,
  exchange: HostMediaHttpExchange, externalOperationId: string): MediaNativeTerminalObservation | undefined {
  assertActual(native, exchange);
  const state = requirePlan(plan);
  if (state.protocol === "image_response_v1" || !validId(externalOperationId) || exchange.request.method !== "GET"
    || !successful(exchange) || !statusRoutes(state, externalOperationId).some(route => exchange.request.routeDigest === route.routeDigest)) return undefined;
  const body = actualJson(native, exchange);
  if (!record(body)) return undefined;
  if (state.protocol === "seedance_task_v1") {
    const decoded = decodeSeedanceTaskStatusResponse(body, externalOperationId);
    if (decoded.status !== "succeeded" && decoded.status !== "failed") return undefined;
    return Object.freeze({ observation: decoded.terminal, payload: Object.freeze(body),
      ...(decoded.status === "succeeded" && decoded.videoUrl ? { videoUrl: decoded.videoUrl } : {}) });
  }
  const decoded = state.protocol === "comfy_jobs_v1"
    ? decodeComfyUiJobObservation(externalOperationId, body) : decodeComfyUiLegacyObservation(externalOperationId, body);
  return decoded.kind === "terminal"
    ? Object.freeze({ observation: decoded.terminalObservation, payload: Object.freeze(decoded.payload) }) : undefined;
}

/** Keep actual output provenance private across owner ticks; mutable SDK recovery cannot populate this matcher. */
export function createMediaNativeRemoteDescriptorMatcher(plan: MediaNativeObservationPlan,
  secretValues: readonly (string | undefined)[] = []): MediaNativeRemoteDescriptorMatcher {
  const state = requirePlan(plan);
  const secrets = Object.freeze([...secretValues]);
  const seen = new WeakSet<HostMediaHttpExchange>();
  const allowed = new Map<string, DownloadPlan>();
  const bytes: ByteSource[] = [];
  const jsonSources: { readonly value: Record<string, unknown>; readonly exchange: HostMediaHttpExchange }[] = [];
  let externalId: string | undefined;
  let identityInvalid = false;
  return Object.freeze({
    capture: (native: HostMediaNativeTransport, exchange: HostMediaHttpExchange) => {
      assertActual(native, exchange);
      if (identityInvalid) throw new Error("media_receipt_submission_identity_conflict");
      if (seen.has(exchange)) return;
      seen.add(exchange);
      if (!successful(exchange)) return;
      if (exchange.request.method === "POST") {
        const kind = state.forwardRoutes.get(exchange.request.routeDigest);
        if (kind === "image_request") {
          const body = actualJson(native, exchange);
          if (!record(body)) return;
          jsonSources.push({ value: body, exchange });
          if (!Array.isArray(body.data)) return;
          for (const item of body.data) {
            if (!record(item)) continue;
            if (typeof item.b64_json === "string" && item.b64_json.trim()) {
              const decoded = imageBase64Digest(item.b64_json);
              if (decoded) bytes.push({ type: "image", bytesSha256: decoded, exchange });
            } else if (typeof item.url === "string") allowDownload(item.url, { type: "image" });
          }
        } else if (kind === "remote_generation_submit") {
          const submission = decodeMediaNativeSubmission(plan, native, exchange);
          if (!submission) return;
          if (externalId !== undefined && externalId !== submission.externalOperationId) {
            identityInvalid = true; bytes.length = 0; jsonSources.length = 0; allowed.clear();
            throw new Error("media_receipt_submission_identity_conflict");
          }
          externalId = submission.externalOperationId;
          const body = actualJson(native, exchange);
          if (record(body)) jsonSources.push({ value: body, exchange });
        }
        return;
      }
      if (exchange.request.method !== "GET") return;
      if (externalId && statusRoutes(state, externalId).some(route => exchange.request.routeDigest === route.routeDigest)) {
        const terminal = decodeMediaNativeTerminal(plan, native, exchange, externalId);
        if (!terminal || terminal.observation.outcome !== "completed") return;
        const body = actualJson(native, exchange);
        if (record(body)) jsonSources.push({ value: body, exchange });
        if (terminal.videoUrl) allowDownload(terminal.videoUrl, { type: "video" });
        else if (state.protocol.startsWith("comfy_")) for (const file of comfyFiles(terminal.payload, state.outputRules)) {
          const query = new URLSearchParams({ filename: file.filename });
          if (file.subfolder) query.set("subfolder", file.subfolder);
          if (file.fileType) query.set("type", file.fileType);
          allowed.set(sha(`${state.base}/api/view?${query.toString()}`), { type: file.artifactType, pathHint: file.filename });
        }
        return;
      }
      const download = allowed.get(exchange.request.routeDigest);
      if (download && mediaContentType(exchange, download)) bytes.push({ ...download, bytesSha256: exchange.bodySha256, exchange });
    },
    getRemoteDescriptor: (candidate: MediaExecutionArtifact, index: number) => {
      if (identityInvalid || !Number.isSafeInteger(index) || index < 0 || !candidate) return undefined;
      if (candidate.contentBytes !== undefined && ["image", "video"].includes(candidate.type)) {
        const digest = sha(Buffer.from(candidate.contentBytes));
        const source = bytes.find(entry => entry.type === candidate.type && entry.bytesSha256 === digest
          && (!entry.pathHint || entry.pathHint === candidate.pathHint));
        return source ? descriptor(source.exchange, index, source.exchange.request.method === "POST" ? "response_item" : "download", source.pathHint) : undefined;
      }
      if (candidate.contentBytes !== undefined || candidate.type !== "json" || typeof candidate.content !== "string") return undefined;
      let body: unknown;
      try { body = JSON.parse(candidate.content); } catch { return undefined; }
      if (!record(body) || !record(body.response)) return undefined;
      // Match the same deterministic Host-redacted projection that is persisted;
      // the resulting descriptor still binds the original native response SHA.
      const source = jsonSources.find(entry => isDeepStrictEqual(redactSecrets(entry.value, secrets), body.response));
      return source ? descriptor(source.exchange, index, "response_item") : undefined;
    },
  });
  function allowDownload(value: string, download: DownloadPlan): void {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || protocolEndpoint(url.pathname)) return;
      url.hash = "";
      allowed.set(sha(url.href), download);
    } catch { /* Invalid output URLs never become download provenance. */ }
  }
}

function statusRoute(state: PlanState, id: string): Readonly<{ url: string; routeDigest: string }> {
  return statusRoutes(state, id)[0]!;
}
function statusRoutes(state: PlanState, id: string): readonly Readonly<{ url: string; routeDigest: string }>[] {
  if (!validId(id) || state.protocol === "image_response_v1") throw new Error("media_receipt_status_route_invalid");
  const paths = state.protocol === "seedance_task_v1" ? ["/contents/generations/tasks/"]
    : state.protocol === "comfy_jobs_v1" ? ["/api/jobs/"] : ["/api/history_v2/", "/api/history/", "/history/"];
  return Object.freeze(paths.map(path => {
    const url = `${state.base}${path}${encodeURIComponent(id)}`;
    return Object.freeze({ url, routeDigest: sha(url) });
  }));
}
function requirePlan(plan: MediaNativeObservationPlan): PlanState {
  const state = plans.get(plan);
  if (!state) throw new Error("media_receipt_observation_plan_unissued");
  return state;
}
function assertActual(native: HostMediaNativeTransport, exchange: HostMediaHttpExchange): void {
  assertHostMediaNativeTransport(native); native.assertExchange(exchange);
}
function actualJson(native: HostMediaNativeTransport, exchange: HostMediaHttpExchange): unknown {
  try { return native.readJson(exchange); } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}
function successful(exchange: HostMediaHttpExchange): boolean { return exchange.httpStatus >= 200 && exchange.httpStatus < 300; }
function validId(value: unknown): value is string { return typeof value === "string" && !!value && value === value.trim() && value.length <= 4096; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function descriptor(exchange: HostMediaHttpExchange, index: number, kind: "response_item" | "download", pathHint?: string): HostMediaArtifactRemoteDescriptor {
  return Object.freeze({ schemaVersion: 1, routeDigest: exchange.request.routeDigest, responseBodySha256: exchange.bodySha256,
    candidateIndex: index, descriptorKind: kind, ...(pathHint === undefined ? {} : { pathHint }) });
}
function imageBase64Digest(value: string): string | undefined {
  if (value.length > 36 * 1024 * 1024) return undefined;
  try {
    const bytes = Buffer.from(atob(value.replace(/\s+/gu, "")), "latin1");
    return bytes.length <= 25 * 1024 * 1024 ? sha(bytes) : undefined;
  } catch { return undefined; }
}
function protocolEndpoint(path: string): boolean {
  return /\/(?:contents\/generations\/tasks|images\/generations)(?:\/|$)/u.test(path)
    || /^\/(?:api\/(?:object_info|prompt|jobs|history|history_v2)|history)(?:\/|$)/u.test(path);
}
function mediaContentType(exchange: HostMediaHttpExchange, download: DownloadPlan): boolean {
  const type = exchange.contentType?.split(";")[0]?.trim().toLowerCase();
  if (type) return type.startsWith(`${download.type}/`) || type === "application/octet-stream";
  return !!download.pathHint && (download.type === "image" ? /\.(png|jpe?g|webp|gif)$/iu : /\.(mp4|webm|mov)$/iu).test(download.pathHint);
}
interface ComfyFile { readonly filename: string; readonly subfolder?: string; readonly fileType?: string; readonly artifactType: "image" | "video" }
/** Mirror Comfy's selected-node/first/all/dedup/view-query projection without accepting caller file lists. */
function comfyFiles(payload: Readonly<Record<string, unknown>>, rules: readonly MediaWorkflowOutputRule[]): ComfyFile[] {
  const outputs = record(payload.outputs) ? payload.outputs : record(payload.data) && record(payload.data.outputs) ? payload.data.outputs
    : record(payload.result) && record(payload.result.outputs) ? payload.result.outputs : undefined;
  if (!outputs) return [];
  const files: ComfyFile[] = [], seen = new Set<string>();
  for (const rule of rules) {
    const candidates: ComfyFile[] = [];
    visit(outputs[rule.nodeId], rule.artifactType, candidates, 0);
    for (const file of rule.collect === "first" ? candidates.slice(0, 1) : candidates) {
      const key = JSON.stringify([file.fileType ?? "", file.subfolder ?? "", file.filename, file.artifactType]);
      if (seen.has(key)) continue;
      seen.add(key); files.push(file);
      if (files.length === 8) return files;
    }
  }
  return files;
}
function visit(value: unknown, type: "image" | "video", files: ComfyFile[], depth: number): void {
  if (depth > 64 || files.length > 1024) throw new Error("media_receipt_output_descriptor_budget_exceeded");
  if (Array.isArray(value)) { for (const item of value) visit(item, type, files, depth + 1); return; }
  if (!record(value)) return;
  if (typeof value.filename === "string") files.push({ filename: value.filename, artifactType: type,
    ...(typeof value.subfolder === "string" ? { subfolder: value.subfolder } : {}),
    ...(typeof value.type === "string" ? { fileType: value.type } : {}) });
  for (const item of Object.values(value)) visit(item, type, files, depth + 1);
}
