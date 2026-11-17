import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { redactSecrets, type AutomationEventEnvelope, type AutomationEventSource, type SecretResolver } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

const header = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  if (typeof value !== "string" || !value || value.length > 256) throw new HttpError(400, "automation_event_header_invalid", `Required event header: ${name}`);
  return value;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Verify the raw bytes before interpreting or persisting any event content. */
export function authenticateAutomationEvent(input: { source: AutomationEventSource; headers: IncomingHttpHeaders; body: Buffer;
  secretResolver: SecretResolver; now: string }): Omit<AutomationEventEnvelope, "id" | "receivedAt"> {
  const { source, headers, body } = input;
  if (!source.enabled) throw new HttpError(409, "automation_event_source_disabled", "This event source is disabled.");
  if (!body.length || body.length > 64 * 1024) throw new HttpError(413, "automation_event_body_limit", "Event body must be 1–65536 bytes.");
  const github = source.adapter === "github";
  const externalId = header(headers, github ? "x-github-delivery" : "x-ling-event-id");
  const timestamp = github ? undefined : header(headers, "x-ling-event-timestamp");
  const type = header(headers, github ? "x-github-event" : "x-ling-event-type");
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(externalId) || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(type)) throw new HttpError(400, "automation_event_identity_invalid", "Invalid event identity.");
  const signature = header(headers, github ? "x-hub-signature-256" : "x-ling-signature-256");
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new HttpError(401, "automation_event_signature_invalid", "Invalid event signature.");
  const supplied = Buffer.from(signature.slice(7), "hex");
  const signed = github ? body : Buffer.concat([Buffer.from(`${timestamp}.${externalId}.${type}.`), body]);
  let verified = false;
  for (const ref of source.secretRefs) {
    const secret = input.secretResolver.resolve(ref, "webhook_secret");
    if (secret.value && timingSafeEqual(createHmac("sha256", secret.value).update(signed).digest(), supplied)) verified = true;
  }
  if (!verified) throw new HttpError(401, "automation_event_signature_invalid", "Invalid event signature.");
  let payload: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object_required");
    payload = value as Record<string, unknown>;
  } catch { throw new HttpError(400, "automation_event_payload_invalid", "Event payload must be a UTF-8 JSON object."); }
  let normalizedType = type;
  let occurredAt = timestamp!;
  if (github) {
    const issue = record(payload.issue), comment = record(payload.comment), repository = record(payload.repository);
    if (!["issues", "issue_comment"].includes(type) || repository.full_name !== source.repository
      || !Number.isSafeInteger(issue.number) || typeof payload.action !== "string" || !/^[a-z_]{1,40}$/.test(payload.action)
      || type === "issue_comment" && !Number.isSafeInteger(comment.id)) throw new HttpError(400, "automation_event_github_scope_invalid", "GitHub event does not match the configured repository/issue adapter.");
    normalizedType = `github.${type}.${payload.action}`;
    occurredAt = String((type === "issue_comment" ? comment : issue).updated_at ?? "");
  }
  const when = Date.parse(occurredAt), now = Date.parse(input.now);
  if (!Number.isFinite(when) || Math.abs(now - when) > 5 * 60_000) throw new HttpError(401, "automation_event_timestamp_invalid", "Event timestamp is outside the five-minute acceptance window.");
  return { sourceId: source.id, externalId, type: normalizedType, occurredAt: new Date(when).toISOString(),
    payloadDigest: createHash("sha256").update(body).digest("hex"), payload: redactSecrets(payload) as Record<string, unknown> };
}
