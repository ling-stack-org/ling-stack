import { createHmac } from "node:crypto";
import type { RunEvaluationHumanHostBindingV1, RunEvaluationHumanIntentV1,
  RunEvaluationHumanConfirmationV1, RunEvaluationHumanSubmissionV1,
  RunEvaluationHumanHeadV1, RunEvaluationHumanEventV1 } from "@ling-stack/contracts";
import { parseHumanEvaluationListResponse, parseHumanEvaluationReportResponse } from "./read-response.js";

export interface HumanEvaluationConnection {
  readonly authority: RunEvaluationHumanHostBindingV1;
  readonly workspaceCwd: string;
  readonly confirmationKey: string;
}
export interface HumanEvaluationDaemonClient {
  handshake(input: { readonly desktopInstanceId: string; readonly desktopEpoch: string;
    readonly workspaceCwd: string; readonly session: { readonly osSessionId: string; readonly osUserId: string;
    readonly lockEpoch: string; readonly locked: false }; readonly platform: "darwin" }, signal: AbortSignal): Promise<HumanEvaluationConnection>;
  intent(input: { readonly authority: RunEvaluationHumanHostBindingV1; readonly taskId: string;
    readonly requestId: string; readonly submission: RunEvaluationHumanSubmissionV1 }, signal: AbortSignal): Promise<RunEvaluationHumanIntentV1>;
  commit(input: { readonly authority: RunEvaluationHumanHostBindingV1; readonly intentId: string;
    readonly confirmation: RunEvaluationHumanConfirmationV1; readonly signature: string }, signal: AbortSignal): Promise<{
    readonly event: { readonly id: string }; readonly head: { readonly revision: number; readonly state: "active" | "revoked" } }>;
  revoke(authority: RunEvaluationHumanHostBindingV1): Promise<void>;
  snapshot(input: { readonly authority: RunEvaluationHumanHostBindingV1; readonly taskId: string;
    readonly afterRevision?: number; readonly intentId?: string;
    readonly reportRef?: { readonly taskId: string; readonly eventId: string; readonly revision: number } }, signal: AbortSignal): Promise<{
    readonly head?: RunEvaluationHumanHeadV1; readonly headEvent?: RunEvaluationHumanEventV1;
    readonly events: readonly RunEvaluationHumanEventV1[]; readonly nextAfterRevision?: number;
    readonly intent?: RunEvaluationHumanIntentV1; readonly reportCurrentness?: "current" | "stale" | "unavailable" }>;
  list(input: { readonly authority: RunEvaluationHumanHostBindingV1; readonly afterEnrollmentId?: string; readonly limit?: number },
    signal: AbortSignal): Promise<ReturnType<typeof parseHumanEvaluationListResponse>>;
  report(input: { readonly authority: RunEvaluationHumanHostBindingV1; readonly taskId: string; readonly eventId: string; readonly revision: number },
    signal: AbortSignal): Promise<ReturnType<typeof parseHumanEvaluationReportResponse>>;
}

/** Transport authentication is private Main provenance, not proof of a human. */
export function createHumanEvaluationDaemonClient(options: {
  readonly daemonBaseUrl: string; readonly bridgeToken: string; readonly fetch?: typeof globalThis.fetch;
}): HumanEvaluationDaemonClient {
  const base = new URL(options.daemonBaseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.search || base.hash || !options.bridgeToken) {
    throw new Error("human_daemon_origin_invalid");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  async function post(action: string, input: object, signal: AbortSignal): Promise<Record<string, unknown>> {
    // A page contains up to 100 full events (4k-char rationale each), one head
    // event and one intent. JSON escaping can cost six bytes per UTF-16 unit;
    // budget wire bytes, not just ASCII or CJK characters. Mutations stay small.
    const responseCap = action === "snapshot" ? 4 * 1_048_576 : action === "list" ? 2 * 1_048_576
      : action === "report" ? 262_144 : 65_536;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const response = await fetchImpl(new URL(`/harness/evaluations/human/desktop/${action}`, base), {
      method: "POST", redirect: "error", signal: boundedSignal,
      headers: { "Content-Type": "application/json", "X-Ling-Desktop-Bridge-Token": options.bridgeToken },
      body: JSON.stringify(input),
    });
    if (!response.body) throw new Error("human_daemon_response_invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        count += next.value.length;
        if (count > responseCap) throw new Error("human_daemon_response_invalid");
        chunks.push(next.value);
      }
    } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!response.ok || !isRecord(value) || value.accepted !== true) throw new Error("human_daemon_rejected");
    return value;
  }
  return Object.freeze({
    async handshake(input, signal) {
      const value = await post("handshake", input, signal);
      if (!isRecord(value.authority) || typeof value.workspaceCwd !== "string"
        || typeof value.confirmationKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.confirmationKey)) {
        throw new Error("human_daemon_response_invalid");
      }
      const authority = value.authority;
      const keys = ["daemonEpoch", "desktopInstanceId", "desktopEpoch", "connectionEpoch", "osSessionId", "osUserId", "lockEpoch"];
      if (Object.keys(authority).length !== keys.length || !keys.every((key) =>
        typeof authority[key] === "string" && (authority[key] as string).length > 0 && (authority[key] as string).length <= 160)) {
        throw new Error("human_daemon_response_invalid");
      }
      return Object.freeze({ authority: Object.freeze({ ...authority }) as unknown as RunEvaluationHumanHostBindingV1,
        workspaceCwd: value.workspaceCwd, confirmationKey: value.confirmationKey });
    },
    async intent(input, signal) {
      const value = await post("intent", input, signal);
      if (!isRecord(value.intent) || value.intent.schemaVersion !== 1 || value.intent.state !== "pending"
        || typeof value.intent.id !== "string" || typeof value.intent.payloadDigest !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.intent.payloadDigest) || typeof value.intent.createdAt !== "string"
        || !isRecord(value.intent.payload)) throw new Error("human_daemon_response_invalid");
      return value.intent as unknown as RunEvaluationHumanIntentV1;
    },
    async commit(input, signal) {
      const value = await post("commit", input, signal);
      if (!isRecord(value.event) || typeof value.event.id !== "string" || !isRecord(value.head)
        || !Number.isSafeInteger(value.head.revision) || Number(value.head.revision) < 1
        || !["active", "revoked"].includes(String(value.head.state))) throw new Error("human_daemon_response_invalid");
      return { event: { id: value.event.id }, head: { revision: value.head.revision as number,
        state: value.head.state as "active" | "revoked" } };
    },
    async revoke(authority) { await post("revoke-authority", { authority }, new AbortController().signal); },
    async snapshot(input, signal) {
      const value = await post("snapshot", input, signal);
      if (!Array.isArray(value.events) || value.events.length > 100
        || (input.reportRef !== undefined && !["current", "stale", "unavailable"].includes(String(value.reportCurrentness)))
        || (input.reportRef === undefined && value.reportCurrentness !== undefined)
        || (value.nextAfterRevision !== undefined && (!Number.isSafeInteger(value.nextAfterRevision) || Number(value.nextAfterRevision) < 1))
        || (value.head !== undefined && (!isRecord(value.head) || value.head.taskId !== input.taskId))
        || (value.headEvent !== undefined && (!isRecord(value.headEvent) || value.headEvent.taskId !== input.taskId))
        || value.events.some(event => !isRecord(event) || event.taskId !== input.taskId)
        || (value.intent !== undefined && (!isRecord(value.intent) || value.intent.id !== input.intentId
          || !isRecord(value.intent.payload) || value.intent.payload.taskId !== input.taskId))) {
        throw new Error("human_daemon_response_invalid");
      }
      return value as unknown as Awaited<ReturnType<HumanEvaluationDaemonClient["snapshot"]>>;
    },
    async list(input, signal) {
      return parseHumanEvaluationListResponse(await post("list", input, signal), input.limit ?? 25);
    },
    async report(input, signal) {
      return parseHumanEvaluationReportResponse(await post("report", input, signal), input);
    },
  } satisfies HumanEvaluationDaemonClient);
}

export function signHumanEvaluationConfirmation(connection: HumanEvaluationConnection, intentId: string,
  confirmation: RunEvaluationHumanConfirmationV1): string {
  const a = connection.authority;
  const bytes = JSON.stringify(["ling.human-evaluation.confirmation.v1", a.daemonEpoch, a.desktopInstanceId,
    a.desktopEpoch, a.connectionEpoch, a.osSessionId, a.osUserId, a.lockEpoch, intentId,
    confirmation.kind, confirmation.requestId, confirmation.payloadDigest, confirmation.confirmedAt]);
  return createHmac("sha256", Buffer.from(connection.confirmationKey, "base64url")).update(bytes, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
