import { DeviceBrokerError } from "@ling-stack/core";
import { WebSocket } from "ws";

export const HOME_ASSISTANT_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const homeAssistantCatalogCapabilities = {
  devices: "home_assistant.list_devices",
  entities: "home_assistant.list_entities",
  services: "home_assistant.list_services",
} as const;
export type HomeAssistantCatalogKind = keyof typeof homeAssistantCatalogCapabilities;

export interface HomeAssistantCatalogQuery {
  readonly kind: HomeAssistantCatalogKind;
  readonly after?: string;
  readonly limit: number;
}

type CatalogItem =
  | { readonly id: string; readonly disabled: boolean }
  | { readonly id: string; readonly availability: "available" | "unavailable" }
  | { readonly id: string; readonly acceptsTarget: boolean };

const identifier = /^[a-z0-9_]+\.[a-z0-9_]+$/u;
const deviceIdPattern = /^[a-f0-9]{32}$/u;

export function isHomeAssistantCatalogKind(value: unknown): value is HomeAssistantCatalogKind {
  return typeof value === "string" && Object.hasOwn(homeAssistantCatalogCapabilities, value);
}

export function assertHomeAssistantCatalogQuery(query: HomeAssistantCatalogQuery): void {
  const cursorPattern = query.kind === "devices" ? deviceIdPattern : identifier;
  if (!isHomeAssistantCatalogKind(query.kind) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100
    || (query.after !== undefined && (typeof query.after !== "string" || query.after.length > 160 || !cursorPattern.test(query.after)))) {
    throw new DeviceBrokerError("invalid_request", "Home Assistant catalog query is invalid");
  }
}

export function homeAssistantEntityAvailability(value: unknown): "available" | "unavailable" {
  return typeof value === "string" && value.trim().length > 0 && !["unknown", "unavailable"].includes(value)
    ? "available" : "unavailable";
}

export function projectHomeAssistantCatalog(query: HomeAssistantCatalogQuery, source: unknown, observedAt: string) {
  if (!Array.isArray(source)) throw invalidCatalog();
  const entries = new Map<string, CatalogItem>();
  function add(item: CatalogItem): void {
    if (entries.has(item.id)) throw invalidCatalog();
    entries.set(item.id, item);
  }
  for (const row of source) {
    if (!isRecord(row)) throw invalidCatalog();
    if (query.kind === "devices") {
      if (typeof row.id !== "string" || !deviceIdPattern.test(row.id)) throw invalidCatalog();
      add({ id: row.id, disabled: typeof row.disabled_by === "string" });
    } else if (query.kind === "entities") {
      if (typeof row.entity_id !== "string" || row.entity_id.length > 160 || !identifier.test(row.entity_id)) throw invalidCatalog();
      add({ id: row.entity_id, availability: homeAssistantEntityAvailability(row.state) });
    } else {
      if (typeof row.domain !== "string" || !isRecord(row.services)) throw invalidCatalog();
      for (const [service, definition] of Object.entries(row.services)) {
        const id = `${row.domain}.${service}`;
        if (id.length > 160 || !identifier.test(id) || !isRecord(definition)) throw invalidCatalog();
        add({ id, acceptsTarget: isRecord(definition.target) });
      }
    }
  }
  const ids = [...entries.keys()].sort();
  const start = query.after === undefined ? 0 : ids.findIndex(id => id > query.after!);
  const page = start < 0 ? [] : ids.slice(start, start + query.limit);
  const nextAfter = start >= 0 && start + page.length < ids.length ? page.at(-1) : undefined;
  const result = {
    kind: query.kind, observedAt, items: page.map(id => entries.get(id)!),
    ...(nextAfter ? { nextAfter } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 32 * 1024) throw invalidCatalog();
  return result;
}

export async function readHomeAssistantDeviceRegistry(input: {
  readonly origin: string;
  readonly token: string;
  readonly version: string | undefined;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const endpoint = new URL("/api/websocket", input.origin);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  if (input.signal.aborted) throw new DeviceBrokerError("timeout", "Home Assistant registry request was cancelled");
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      maxPayload: HOME_ASSISTANT_CATALOG_MAX_BYTES,
      followRedirects: false,
      perMessageDeflate: false,
    });
    let stage: "challenge" | "authentication" | "catalog" = "challenge";
    let settled = false;
    const onAbort = () => finish(new DeviceBrokerError("timeout", "Home Assistant registry request was cancelled"));
    function finish(error?: DeviceBrokerError, result?: unknown): void {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      socket.terminate();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on("error", () => finish(new DeviceBrokerError("connection_failed", "Home Assistant registry connection failed")));
    socket.once("close", () => finish(new DeviceBrokerError("connection_failed", "Home Assistant registry connection closed")));
    input.signal.addEventListener("abort", onAbort, { once: true });
    socket.on("message", (data, binary) => {
      if (settled) return;
      try {
        if (binary) throw invalidCatalog();
        const message: unknown = JSON.parse(data.toString());
        if (!isRecord(message)) throw invalidCatalog();
        if (stage === "challenge" && message.type === "auth_required") {
          stage = "authentication";
          socket.send(JSON.stringify({ type: "auth", access_token: input.token }));
          return;
        }
        if (stage === "authentication" && message.type === "auth_invalid") {
          throw new DeviceBrokerError("permission_denied", "Home Assistant rejected the registry credential");
        }
        if (stage === "authentication" && message.type === "auth_ok") {
          if (message.ha_version !== input.version) throw new DeviceBrokerError("target_changed", "Home Assistant registry version changed");
          stage = "catalog";
          socket.send(JSON.stringify({ id: 1, type: "config/device_registry/list" }));
          return;
        }
        if (stage === "catalog" && message.type === "result" && message.id === 1) {
          if (message.success === true) {
            finish(undefined, message.result);
            return;
          }
          if (isRecord(message.error) && ["unauthorized", "forbidden"].includes(String(message.error.code))) {
            throw new DeviceBrokerError("permission_denied", "Home Assistant denied registry access");
          }
        }
        throw invalidCatalog();
      } catch (error) {
        finish(error instanceof DeviceBrokerError ? error : invalidCatalog());
      }
    });
  });
}

function invalidCatalog(): DeviceBrokerError {
  return new DeviceBrokerError("service_unavailable", "Home Assistant returned an invalid catalog");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
