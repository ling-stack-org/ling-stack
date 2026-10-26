import type { IncomingMessage, ServerResponse } from "node:http";
import type { DestinationMessage, ImDestinationProvider } from "@ling-stack/contracts";
import type { DaemonContext } from "../../context.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

const PROVIDERS: readonly ImDestinationProvider[] = ["feishu", "wecom", "dingtalk", "slack"];
const DESTINATION_PATH = /^\/im-destinations\/([A-Za-z0-9_-]+)$/u;

export async function handleImDestinations(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const registry = context.imDestinations;
  await registry.ensureLoaded();

  const destinationMatch = DESTINATION_PATH.exec(url.pathname);
  if (destinationMatch) {
    const id = destinationMatch[1];
    if (url.pathname.endsWith("/test") && request.method === "POST") {
      const destinationId = DESTINATION_PATH.exec(url.pathname.slice(0, -"/test".length))?.[1];
      const destination = registry.list().find((item) => item.id === destinationId);
      if (!destination) {
        writeJson(response, 404, { error: "not_found", message: `Unknown IM destination: ${destinationId}` });
        return;
      }
      const message: DestinationMessage = {
        title: "Ling Stack test message",
        bodyMarkdown: "Your IM destination is working.",
        severity: "info",
      };
      const result = await registry.dispatch(destination, message);
      writeJson(response, result.ok ? 200 : 502, result);
      return;
    }
    if (request.method === "DELETE") {
      const removed = await registry.remove(id);
      writeJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "not_found", message: `Unknown IM destination: ${id}` });
      return;
    }
    if (request.method === "PATCH") {
      try {
        const body = (await readJsonBody(request, context.config.maxBodyBytes)) as { enabled?: unknown };
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
        const updated = await registry.setEnabled(id, body.enabled);
        if (!updated) {
          writeJson(response, 404, { error: "not_found", message: `Unknown IM destination: ${id}` });
          return;
        }
        writeJson(response, 200, { schemaVersion: 1, destinations: registry.list() });
      } catch (error) {
        writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: "Use PATCH or DELETE for IM destinations" });
    return;
  }

  if (url.pathname === "/im-destinations") {
    if (request.method === "GET") {
      writeJson(response, 200, { schemaVersion: 1, destinations: registry.list() });
      return;
    }
    if (request.method === "POST") {
      try {
        const body = await readJsonBody(request, context.config.maxBodyBytes);
        const destination = await registry.create(parseCreateInput(body));
        writeJson(response, 201, { schemaVersion: 1, destinations: registry.list(), destination });
      } catch (error) {
        writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET or POST for IM destinations" });
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `Unknown IM destinations route ${url.pathname}` });
}

function parseCreateInput(raw: unknown): {
  label: string;
  provider: ImDestinationProvider;
  webhookRef: string;
  secretRef?: string;
  enabled?: boolean;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("IM destination input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const provider = String(input.provider ?? "");
  if (!PROVIDERS.includes(provider as ImDestinationProvider)) {
    throw new Error(`provider must be one of ${PROVIDERS.join(", ")}`);
  }
  return {
    label: String(input.label ?? ""),
    provider: provider as ImDestinationProvider,
    webhookRef: String(input.webhookRef ?? ""),
    secretRef: typeof input.secretRef === "string" && input.secretRef.length > 0 ? input.secretRef : undefined,
    enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
  };
}
