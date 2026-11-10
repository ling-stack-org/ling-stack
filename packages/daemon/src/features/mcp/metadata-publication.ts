import type { McpMetadataRequestKind, McpMetadataStoreFacet, SecretResolver } from "@ling-stack/core";
import type { McpBroker } from "../../context.js";
import { HttpError } from "../../errors.js";
import { trimOversizedEvent, type ControlPlaneEventHub } from "../control-plane/events.js";

/** Network awaits occur only between durable admission and atomic publication. */
export async function publishManualMcpMetadata(input: {
  readonly store: McpMetadataStoreFacet;
  readonly serverId: string;
  readonly kind: McpMetadataRequestKind;
  readonly cwd: string;
  readonly broker: McpBroker;
  readonly secretResolver: SecretResolver;
  readonly hub: ControlPlaneEventHub;
}) {
  const request = input.store.beginMcpMetadataRequest(input.serverId, input.kind);
  if (!request) throw new HttpError(404, "mcp_server_not_found", "MCP server no longer exists.");
  const startedAt = new Date().toISOString();
  const options = { secretResolver: input.secretResolver, workspaceCwd: input.cwd, now: () => startedAt };
  const result = input.kind === "check"
    ? { ...await input.broker.checkServer(request.server, options), tools: undefined }
    : await input.broker.listTools(request.server, options);
  const publication = input.store.commitMcpMetadataResult({
    request,
    statusSnapshot: result.statusSnapshot,
    tools: result.tools,
    cwd: input.cwd,
    now: new Date().toISOString(),
  });
  if (!publication.published) {
    throw new HttpError(409, "mcp_metadata_result_superseded", "MCP metadata result was superseded. Refresh current server status.");
  }
  // Core has committed snapshot, catalog and this durable event before notifying listeners.
  try {
    input.hub.publish(trimOversizedEvent(publication.event));
  } catch {
    // The durable event remains replayable. A notification failure cannot turn
    // an already-committed receipt into "failed" or cause effect/state replay.
    process.emitWarning("MCP metadata committed; live notification failed. Replay durable control-plane events.", {
      code: "mcp_metadata_live_notification_failed",
    });
  }
  return publication;
}
