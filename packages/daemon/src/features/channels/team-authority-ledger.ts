import type { IncomingMessage, ServerResponse } from "node:http";
import { buildChannelTeamAuthorityLedgerProjection } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listChannelMessageViews } from "./conversation-item-messages.js";

export async function handleChannelTeamAuthorityLedger(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel team authority ledger` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    const limit = readOptionalIntegerQuery(url, "limit", 1) ?? 100;
    const readLimit = Math.min(Math.max(limit * 4, 100), 500);
    const runs = store.listRuns({ limit: readLimit });
    const channelRunIds = new Set(runs.filter((run) => run.channelId === channelId).map((run) => run.id));
    const approvals = store
      .listApprovalRequests({ limit: readLimit })
      .filter((approval) => approval.channelId === channelId || Boolean(approval.runId && channelRunIds.has(approval.runId)));
    const ledger = buildChannelTeamAuthorityLedgerProjection({
      channelId,
      now: new Date().toISOString(),
      limit,
      runs,
      approvals,
      messages: listChannelMessageViews({ store, channelId, limit: readLimit }),
      resourceLeases: store.listResourceLeases({ limit: readLimit }),
    });
    writeJson(response, 200, { cwd, channelId, ledger });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
