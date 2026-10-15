import { createHmac, randomBytes } from "node:crypto";
import { redactSecrets } from "@ling-stack/core";
import type {
  MediaWorkflowConnection,
  MediaWorkflowConnectionCheckPublication,
  MediaWorkflowConnectionCheckState,
  MediaWorkflowConnectionCheckTicket,
  MediaWorkflowConnectionHealth,
  RunStore,
  SecretResolver,
} from "@ling-stack/core";
import { ComfyUiClient } from "./comfyui-client.js";

interface CredentialObservation {
  readonly apiKey?: string;
  readonly proof: string;
  readonly error?: Error;
}

/** Resolve secrets outside transactions; proofs and keys die with this invocation. */
function observeCredential(connection: MediaWorkflowConnection, resolver: SecretResolver, key: Buffer): CredentialObservation {
  const proof = (kind: string, value = "") => createHmac("sha256", key).update(kind).update("\0").update(value).digest("hex");
  if (connection.authMode === "none") return { proof: proof("none") };
  if (!connection.secretRef) return { proof: proof("missing_ref"), error: new Error("工作流连接缺少 API Key。") };
  const secret = resolver.resolve(connection.secretRef, "workflow_api_key");
  if (!secret.configured || !secret.value) {
    // Do not persist a resolver-supplied diagnostic that could contain secret material.
    return { proof: proof("unconfigured"), error: new Error("工作流连接 API Key 尚未配置。") };
  }
  return { apiKey: secret.value, proof: proof("configured", secret.value) };
}

function staleAuthority(state: MediaWorkflowConnectionCheckState | undefined,
  ticket: MediaWorkflowConnectionCheckTicket): Extract<MediaWorkflowConnectionCheckPublication, { status: "stale" }> | undefined {
  if (!state) return { status: "stale", reason: "deleted" };
  if (state.configRevision !== ticket.configRevision) return { status: "stale", reason: "config_changed", connection: state.connection };
  if (state.requestRevision !== ticket.requestRevision) return { status: "stale", reason: "superseded", connection: state.connection };
  if (state.publishedRevision >= ticket.requestRevision) return { status: "stale", reason: "already_published", connection: state.connection };
  return undefined;
}

/** Candidate inspection errors are not Store failures or authority to publish. */
export async function checkMediaWorkflowConnection(input: {
  readonly store: RunStore;
  readonly connectionId: string;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}): Promise<MediaWorkflowConnectionCheckPublication> {
  const admission = input.store.beginMediaWorkflowConnectionCheck(input.connectionId);
  if (!admission) return { status: "stale", reason: "deleted" };
  const { connection, ticket } = admission;
  const proofKey = randomBytes(32);
  let initial: CredentialObservation;
  try {
    initial = observeCredential(connection, input.secretResolver, proofKey);
  } catch {
    // Reading external credentials failed: identity is unknown, not a bad model
    // response. A failed Store reread propagates and cannot publish error health.
    const state = input.store.getMediaWorkflowConnectionCheckState(ticket.connectionId);
    if (!state) return { status: "stale", reason: "deleted" };
    return staleAuthority(state, ticket) ?? { status: "stale", reason: "credential_unavailable", connection: state.connection };
  }

  let health: MediaWorkflowConnectionHealth;
  try {
    if (initial.error) throw initial.error;
    const inspection = await new ComfyUiClient({ connection, apiKey: initial.apiKey }).inspect();
    const nodeCount = Object.keys(inspection.objectInfo).length;
    health = { ok: true, message: `连接正常，已读取 ${nodeCount} 种节点。`, checkedAt: input.now,
      protocolVariant: inspection.protocolVariant, nodeCount };
  } catch (error) {
    // Native JSON diagnostics can quote response bytes, including only a prefix
    // or an escaped form of a credential. Do not project any such body excerpt.
    const message = error instanceof SyntaxError
      ? "ComfyUI 返回的 JSON 格式无效。"
      : error instanceof Error ? error.message : String(error);
    // Transport/policy diagnostics remain useful, but an arbitrary bearer key
    // must not rely on matching the generic sk-/Authorization redaction rules.
    health = { ok: false, message: redactSecrets(message, [initial.apiKey]) as string, checkedAt: input.now };
  }

  const state = input.store.getMediaWorkflowConnectionCheckState(ticket.connectionId);
  if (!state) return { status: "stale", reason: "deleted" };
  const stale = staleAuthority(state, ticket);
  if (stale) return stale;
  let current: CredentialObservation;
  try {
    current = observeCredential(state.connection, input.secretResolver, proofKey);
  } catch {
    return { status: "stale", reason: "credential_unavailable", connection: state.connection };
  }
  if (initial.proof !== current.proof) return { status: "stale", reason: "credential_changed", connection: state.connection };
  // No await between the effective-value observation and the synchronous CAS.
  // Concurrent database writers are still fenced by the transaction's revisions.
  return input.store.commitMediaWorkflowConnectionCheck(ticket, health, new Date().toISOString());
}
