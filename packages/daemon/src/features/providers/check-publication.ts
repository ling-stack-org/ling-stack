import type {
  ProviderCheckPublicationResult, ProviderCheckPublicationStore, ProviderCheckRequestTicket, ProviderCheckResult,
} from "@ling-stack/core";
import type { ControlPlaneEventHub } from "../control-plane/events.js";

/** Publish only committed evidence. A notification failure never reverses the durable receipt. */
export function publishProviderCheckResult(
  store: ProviderCheckPublicationStore,
  hub: ControlPlaneEventHub,
  ticket: ProviderCheckRequestTicket,
  result: ProviderCheckResult,
  cwd: string,
): ProviderCheckPublicationResult {
  const publication = store.commitProviderCheckResult(ticket, result, cwd);
  if (publication.status === "published") {
    try {
      hub.publish(publication.event);
    } catch {
      console.warn("Provider check committed; live notification failed. Durable replay remains available.");
    }
  }
  return publication;
}
