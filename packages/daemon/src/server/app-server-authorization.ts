import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  LING_APP_SERVER_GRANT_SCOPES,
  type LingAppServerGrant,
  type LingAppServerGrantScope,
  type LingAppServerGrantSubject,
} from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { HttpError } from "../errors.js";
import { isRecord } from "../shared/validation.js";

interface GrantRecord {
  readonly grant: LingAppServerGrant;
  readonly credentialSha256: string;
}

export const appServerGrantBearerPrefix = "Bearer las1.";
const grantCredential = /^Bearer las1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/u;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function authenticateAppServerGrant(store: RunStore, authorization: string): LingAppServerGrant | undefined {
  const match = grantCredential.exec(authorization);
  if (!match) return undefined;
  const record = readGrant(store, match[1]);
  if (!record || !grantActive(record.grant)) return undefined;
  return timingSafeEqual(Buffer.from(sha256(match[2]), "hex"), Buffer.from(record.credentialSha256, "hex"))
    ? record.grant : undefined;
}

export function appServerGrantStillActive(store: RunStore, grant: LingAppServerGrant): boolean {
  const current = readGrant(store, grant.grantId)?.grant;
  return current?.revision === grant.revision && grantActive(current);
}

function grantActive(grant: LingAppServerGrant): boolean {
  return !grant.revokedAt && Date.parse(grant.expiresAt) > Date.now();
}

function readGrant(store: RunStore, grantId: string): GrantRecord | undefined {
  return store.getAppServerState("authorization_grant", grantId)?.payload as GrantRecord | undefined;
}

export function createAppServerGrant(store: RunStore, input: Record<string, unknown>): LingAppServerGrant {
  const { label, subject, scopes, expiresAt, credentialSha256, idempotencyKey } = input;
  const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (typeof label !== "string" || !label.trim() || label.length > 160
    || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 200 || /[\r\n]/u.test(idempotencyKey)
    || typeof credentialSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(credentialSha256)
    || !Array.isArray(scopes) || !scopes.length || scopes.length > LING_APP_SERVER_GRANT_SCOPES.length
    || scopes.some(scope => !LING_APP_SERVER_GRANT_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length
    || !Number.isFinite(expires) || expires <= Date.now()) {
    throw new HttpError(400, "invalid_params", "Supply a label, scopes, future expiry, credential digest and idempotency key.");
  }
  const validatedSubject = grantSubject(store, subject);
  if (validatedSubject.kind === "workItem" && (scopes.includes("approve") || scopes.includes("respond"))) {
    throw new HttpError(400, "invalid_params", "Approval and input scopes require a Thread or workspace grant.");
  }
  const grant: LingAppServerGrant = {
    grantId: randomUUID(), label: label.trim(), subject: validatedSubject,
    scopes: [...scopes].sort(), revision: 1, createdAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString(),
  };
  const record: GrantRecord = { grant, credentialSha256 };
  const retained = store.putAppServerState({
    kind: "authorization_grant", recordId: grant.grantId, expectedRevision: 0, idempotencyKey,
    replayByIdempotencyKey: true, payload: record,
  }, grant.createdAt);
  if (!retained) throw new HttpError(409, "grant_conflict", "The App Server grant could not be committed.");
  const saved = retained.record.payload as GrantRecord;
  if (saved.credentialSha256 !== credentialSha256 || saved.grant.label !== grant.label || saved.grant.expiresAt !== grant.expiresAt
    || JSON.stringify(saved.grant.scopes) !== JSON.stringify(grant.scopes) || JSON.stringify(saved.grant.subject) !== JSON.stringify(grant.subject)) {
    throw new HttpError(409, "idempotency_conflict", "The grant key belongs to a different request.");
  }
  return saved.grant;
}

function grantSubject(store: RunStore, value: unknown): LingAppServerGrantSubject {
  if (isRecord(value)) {
    if (value.kind === "workspace") return { kind: "workspace" };
    if (typeof value.id === "string" && (value.kind === "thread" && store.getLingThread(value.id)
      || value.kind === "workItem" && store.getWorkItem(value.id))) return { kind: value.kind, id: value.id };
  }
  throw new HttpError(400, "invalid_params", "The grant subject must exist in the bound workspace.");
}

export function listAppServerGrants(store: RunStore): readonly LingAppServerGrant[] {
  return store.listAppServerState("authorization_grant").map(record => (record.payload as GrantRecord).grant);
}

export function revokeAppServerGrant(store: RunStore, grantId: string, expectedRevision: number): LingAppServerGrant {
  const saved = store.getAppServerState("authorization_grant", grantId);
  if (!saved) throw new HttpError(404, "grant_not_found", "The App Server grant was not found.");
  const record = saved.payload as GrantRecord;
  if (record.grant.revokedAt && expectedRevision === saved.revision - 1) return record.grant;
  if (saved.revision !== expectedRevision || record.grant.revokedAt) throw new HttpError(409, "stale_revision", "The App Server grant revision changed.");
  const revokedAt = new Date().toISOString();
  const grant: LingAppServerGrant = { ...record.grant, revision: saved.revision + 1, revokedAt };
  if (!store.putAppServerState({ kind: "authorization_grant", recordId: grantId, expectedRevision,
    payload: { ...record, grant } }, revokedAt)) throw new HttpError(409, "stale_revision", "The App Server grant revision changed.");
  return grant;
}

const serverMethods = new Set(["initialize", "server/ping", "server/capabilities"]);
const threadReads = new Set([
  "thread/read", "thread/resume", "thread/snapshot", "thread/turns/list", "thread/items/list", "thread/events/read",
  "thread/subscribe", "thread/unsubscribe", "thread/mode/get", "thread/goal/get", "item/read", "context/inspect",
]);
const threadControls = new Set(["turn/start", "turn/queue", "turn/interrupt", "turn/resume"]);
const workItemReads = new Set([
  "workItem/read", "workItem/subscribe", "workItem/unsubscribe", "workItem/evidence/read", "workItem/collaboration/read",
  "workItem/stage/read", "workItem/stage/brief/read", "workItem/coordination/read", "workItem/deliberation/read",
  "workItem/message/read", "workItem/message/list", "workItem/question/read", "workItem/handoff/read",
]);
const workItemControls = new Set(["workItem/pause", "workItem/resume", "workItem/cancel"]);

export function grantAllowsMethod(grant: LingAppServerGrant, method: string): boolean {
  if (serverMethods.has(method)) return true;
  const hasScope = (scope: LingAppServerGrantScope) => grant.scopes.includes(scope);
  const thread = grant.subject.kind !== "workItem";
  const workItem = grant.subject.kind !== "thread";
  if (thread && threadReads.has(method) || workItem && workItemReads.has(method)) return hasScope("observe");
  if (thread && threadControls.has(method) || workItem && workItemControls.has(method)) return hasScope("control");
  if (thread && method === "approval/respond") return hasScope("approve");
  if (thread && method === "input/respond") return hasScope("respond");
  return false;
}

export function grantAllowsRequest(store: RunStore, grant: LingAppServerGrant, method: string, input: Record<string, unknown>): boolean {
  if (!grantAllowsMethod(grant, method)) return false;
  const subject = grant.subject;
  if (subject.kind === "workspace" || serverMethods.has(method) || method.endsWith("/unsubscribe")) return true;
  if (subject.kind === "workItem") return input.workItemId === subject.id;
  if (method === "approval/respond") {
    const approval = typeof input.approvalId === "string" ? store.getApprovalRequest(input.approvalId) : undefined;
    return !!approval?.runId && store.getRun(approval.runId)?.threadId === subject.id;
  }
  if (method === "input/respond") return isRecord(input.authority) && input.authority.threadId === subject.id;
  if (method === "turn/resume") {
    return typeof input.turnId === "string" && store.getLingTurn(input.turnId)?.threadId === subject.id;
  }
  return input.threadId === subject.id;
}
