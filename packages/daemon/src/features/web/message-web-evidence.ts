import type {
  ChannelMessage,
  MessageWebEvidence,
  MessageWebEvidenceProvider,
  MessageWebEvidenceReadUrl,
  MessageWebEvidenceSource,
  RunStore,
  TeammateDirectMessage,
} from "@ling-stack/core";
import type { WebEvidenceContext } from "./web-evidence-service.js";

export const WEB_EVIDENCE_RECORDED_EVENT = "web_evidence_recorded";

interface MessageWebEvidenceEventData extends MessageWebEvidence {
  readonly toolSurface: "web";
  readonly sourceMessageId: string;
  readonly linkedMessageId: string;
  readonly sourceCount: number;
  readonly readUrlCount: number;
}

export function recordMessageWebEvidenceEvent(input: {
  readonly store: Pick<RunStore, "appendRuntimeEvent">;
  readonly workUnitId: string;
  readonly attemptId?: string;
  readonly sourceMessageId: string;
  readonly linkedMessageId: string;
  readonly context: WebEvidenceContext;
  readonly ts: string;
}): MessageWebEvidence | undefined {
  const evidence = buildMessageWebEvidence(input.context, input.ts);
  if (!evidence) {
    return undefined;
  }
  const data: MessageWebEvidenceEventData = {
    toolSurface: "web",
    sourceMessageId: input.sourceMessageId,
    linkedMessageId: input.linkedMessageId,
    sourceCount: evidence.sources.length,
    readUrlCount: evidence.readUrls.length,
    ...evidence,
  };
  input.store.appendRuntimeEvent({
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
    type: WEB_EVIDENCE_RECORDED_EVENT,
    actor: "system",
    ts: input.ts,
    data,
  });
  return evidence;
}

export function enrichChannelMessageWithWebEvidence(
  store: Pick<RunStore, "listWorkUnits" | "listRuntimeEvents">,
  message: ChannelMessage,
): ChannelMessage {
  const evidence = findLatestMessageWebEvidence(store, message.id);
  return evidence ? { ...message, webEvidence: evidence } : message;
}

export function enrichChannelMessagesWithWebEvidence(
  store: Pick<RunStore, "listWorkUnits" | "listRuntimeEvents">,
  messages: readonly ChannelMessage[],
): readonly ChannelMessage[] {
  return messages.map((message) => enrichChannelMessageWithWebEvidence(store, message));
}

export function enrichTeammateDirectMessageWithWebEvidence(
  store: Pick<RunStore, "listWorkUnits" | "listRuntimeEvents">,
  message: TeammateDirectMessage,
): TeammateDirectMessage {
  const evidence = findLatestMessageWebEvidence(store, message.id);
  return evidence ? { ...message, webEvidence: evidence } : message;
}

export function enrichTeammateDirectMessagesWithWebEvidence(
  store: Pick<RunStore, "listWorkUnits" | "listRuntimeEvents">,
  messages: readonly TeammateDirectMessage[],
): readonly TeammateDirectMessage[] {
  return messages.map((message) => enrichTeammateDirectMessageWithWebEvidence(store, message));
}

function findLatestMessageWebEvidence(
  store: Pick<RunStore, "listWorkUnits" | "listRuntimeEvents">,
  messageId: string,
): MessageWebEvidence | undefined {
  let latest: MessageWebEvidence | undefined;
  const workUnits = store.listWorkUnits({ linkedMessageId: messageId, limit: 10 });
  for (const workUnit of workUnits) {
    const events = store.listRuntimeEvents(workUnit.id, { limit: 200 });
    for (const event of events) {
      if (event.type !== WEB_EVIDENCE_RECORDED_EVENT) {
        continue;
      }
      const evidence = readMessageWebEvidence(event.data);
      if (!evidence) {
        continue;
      }
      if (!latest || evidence.updatedAt.localeCompare(latest.updatedAt) >= 0) {
        latest = evidence;
      }
    }
  }
  return latest;
}

function buildMessageWebEvidence(context: WebEvidenceContext, updatedAt: string): MessageWebEvidence | undefined {
  if (context.status === "not_applicable") {
    return undefined;
  }
  const sources = normalizeSources(context.search?.sources ?? []);
  const readUrls = normalizeReadUrls(context.readUrls ?? []);
  if (!context.reason && !context.search && sources.length === 0 && readUrls.length === 0) {
    return undefined;
  }
  return {
    status: context.status,
    ...(context.search?.query ? { query: trimString(context.search.query, 600) } : {}),
    ...(context.search?.provider ? { provider: normalizeProvider(context.search.provider) } : {}),
    ...(context.reason ? { reason: trimString(context.reason, 600) } : {}),
    sources,
    readUrls,
    updatedAt,
  };
}

function readMessageWebEvidence(data: unknown): MessageWebEvidence | undefined {
  if (!isRecord(data) || data.toolSurface !== "web") {
    return undefined;
  }
  const status = data.status === "available" || data.status === "blocked" ? data.status : undefined;
  const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : undefined;
  if (!status || !updatedAt) {
    return undefined;
  }
  return {
    status,
    ...(typeof data.query === "string" ? { query: trimString(data.query, 600) } : {}),
    ...(isRecord(data.provider) ? { provider: normalizeProvider(data.provider) } : {}),
    ...(typeof data.reason === "string" ? { reason: trimString(data.reason, 600) } : {}),
    sources: Array.isArray(data.sources) ? normalizeSources(data.sources) : [],
    readUrls: Array.isArray(data.readUrls) ? normalizeReadUrls(data.readUrls) : [],
    updatedAt,
  };
}

function normalizeProvider(value: {
  readonly adapterId?: unknown;
  readonly providerPresetId?: unknown;
  readonly displayName?: unknown;
}): MessageWebEvidenceProvider {
  return {
    adapterId: typeof value.adapterId === "string" ? trimString(value.adapterId, 120) : "unknown",
    providerPresetId: typeof value.providerPresetId === "string" ? trimString(value.providerPresetId, 160) : "unknown",
    displayName: typeof value.displayName === "string" ? trimString(value.displayName, 160) : "Unknown provider",
  };
}

function normalizeSources(values: readonly unknown[]): readonly MessageWebEvidenceSource[] {
  return values
    .filter(isRecord)
    .map((value) => {
      const url = typeof value.url === "string" ? trimString(value.url, 2_000) : "";
      if (!url) {
        return undefined;
      }
      return {
        url,
        ...(typeof value.title === "string" ? { title: trimString(value.title, 240) } : {}),
        ...(typeof value.snippet === "string" ? { snippet: trimString(value.snippet, 360) } : {}),
      };
    })
    .filter((source): source is MessageWebEvidenceSource => Boolean(source))
    .slice(0, 12);
}

function normalizeReadUrls(values: readonly unknown[]): readonly MessageWebEvidenceReadUrl[] {
  return values
    .filter(isRecord)
    .map((value) => {
      const url = typeof value.url === "string" ? trimString(value.url, 2_000) : "";
      const status = value.status === "available" || value.status === "blocked" ? value.status : undefined;
      if (!url || !status) {
        return undefined;
      }
      return {
        url,
        status,
        ...(typeof value.finalUrl === "string" ? { finalUrl: trimString(value.finalUrl, 2_000) } : {}),
        ...(typeof value.title === "string" ? { title: trimString(value.title, 240) } : {}),
        ...(typeof value.reason === "string" ? { reason: trimString(value.reason, 600) } : {}),
      };
    })
    .filter((readUrl): readUrl is MessageWebEvidenceReadUrl => Boolean(readUrl))
    .slice(0, 8);
}

function trimString(value: string, maxLength: number): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
