import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import type { OptionalSkillPackAction, OptionalSkillPackId } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalServiceRequest, allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { appendControlPlaneEvent, type ControlPlaneEventHub } from "../control-plane/events.js";
import { desktopBridgeTokenStatus } from "../computer-use/desktop-bridge-auth.js";
import { optionalSkillPacks } from "./optional-pack-catalog.js";
import { changeOptionalSkillPack, listOptionalSkillPacks } from "./optional-pack-installation.js";
import { flushSkillDefinitionRevisionNotices } from "./revision-notices.js";

export async function handleOptionalSkillPackRoute(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  storeRegistry: RunStoreRegistry;
  controlPlaneEvents: ControlPlaneEventHub;
  maxBodyBytes: number;
  desktopBridgeToken?: string;
}): Promise<boolean> {
  const { request, response, url, storeRegistry, controlPlaneEvents } = input;
  const route = /^\/plugins\/skill-packs(?:\/([a-z-]+))?$/u.exec(url.pathname);
  if (!route) return false;
  if (!allowLocalServiceRequest(request, response)) return true;
  try {
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "bad_request", "A workspace is required.");
    if (!allowLocalWorkspaceRequest({ request, response, storeRegistry, cwd })) return true;
    if (request.method === "POST" && input.desktopBridgeToken) {
      if (request.headers.origin !== undefined) {
        throw new HttpError(403, "desktop_bridge_forbidden", "Manage skill packs from the Ling desktop application.");
      }
      if (input.desktopBridgeToken && desktopBridgeTokenStatus(request, input.desktopBridgeToken) !== "accepted") {
        throw new HttpError(403, "desktop_bridge_forbidden", "Manage skill packs from the Ling desktop application.");
      }
    }
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET" && !route[1]) {
      writeJson(response, 200, { packs: await listOptionalSkillPacks(store) });
    } else if (request.method === "POST" && route[1]) {
      if (!Object.hasOwn(optionalSkillPacks, route[1])) throw new HttpError(404, "skill_pack_not_found", "Skill pack not found.");
      const id = route[1] as OptionalSkillPackId;
      const action = parseAction(await readJsonBody(request, input.maxBodyBytes));
      await changeOptionalSkillPack(store, id, action, new Date().toISOString());
      flushSkillDefinitionRevisionNotices(store, controlPlaneEvents, cwd);
      appendControlPlaneEvent(store, controlPlaneEvents, { workspaceId: DEFAULT_WORKSPACE_ID, cwd, domain: "skills",
        entityType: "registry", entityId: id, action: "skill.registry_changed", data: { changeType: `pack_${action.action}` } });
      writeJson(response, 200, { packs: await listOptionalSkillPacks(store) });
    } else {
      throw new HttpError(405, "method_not_allowed", "This method is unavailable for the skill pack route.");
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      // Errors from a user's source directory must not expose paths in server responses.
      writeJson(response, 409, { error: "skill_pack_preparation_failed", message: "The skill pack could not be prepared. Check its files and dependencies and try again." });
    } else {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
    }
  }
  return true;
}

function parseAction(raw: unknown): OptionalSkillPackAction {
  if (isRecord(raw)) {
    switch (raw.action) {
      case "install": case "enable": case "disable": case "uninstall": case "rollback": return { action: raw.action };
      case "connect": {
        if (typeof raw.path === "string" && raw.path.trim() && raw.path.length <= 4096) return { action: raw.action, path: raw.path.trim() };
      }
    }
  }
  throw new HttpError(400, "skill_pack_action_invalid", "Choose a supported skill pack operation.");
}
