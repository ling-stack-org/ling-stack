import type { IncomingMessage, ServerResponse } from "node:http";
import { buildChannelEvidenceSummaryProjection, buildChannelTeamMetricsProjection } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { enrichChannelMessagesWithWebEvidence } from "../web/message-web-evidence.js";
import { listChannelMessageViews } from "./conversation-item-messages.js";

export async function handleChannelTeamMetricsProjection(
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
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel team metrics` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    const now = new Date().toISOString();
    const limit = readOptionalIntegerQuery(url, "limit", 1) ?? 500;
    const tasks = store.listTasks({ channelId, limit });
    const taskIds = new Set(tasks.map((task) => task.id));
    const runs = store
      .listRuns({ limit: Math.max(limit * 4, 500) })
      .filter((run) => run.channelId === channelId || taskIds.has(run.taskId));
    const workflowSteps = store
      .listChannelWorkflows({ channelId, limit })
      .flatMap((workflow) => store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 500 }));
    const approvals = store.listApprovalRequests({ limit: Math.max(limit * 4, 500) });
    const messages = enrichChannelMessagesWithWebEvidence(store, listChannelMessageViews({ store, channelId, limit }));
    const attachments = store.listChannelAttachments({ channelId, limit });
    const artifacts = runs.flatMap((run) => store.listArtifacts(run.id));
    const teamEvidence = store.listChannelTeamEvidenceItems({
      channelId,
      now,
      limit,
    });
    const metrics = buildChannelTeamMetricsProjection({
      channelId,
      now,
      evidence: teamEvidence,
      visibleEvidence: buildChannelEvidenceSummaryProjection({
        channelId,
        generatedAt: now,
        runs,
        approvals,
        messages,
        attachments,
        artifacts,
        tasks,
        workflowSteps,
        teamEvidence,
      }),
      reliabilityIncidents: store.listReliabilityIncidents({ now, limit }),
      availabilityIncidents: store.listAvailabilityIncidents({ now, limit }),
      patterns: store.listChannelTeamPatterns({
        channelId,
        now,
        includeExpired: true,
        limit,
      }),
    });
    writeJson(response, 200, { cwd, channelId, metrics });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
