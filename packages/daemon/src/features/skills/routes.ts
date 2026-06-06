import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { SkillRoute } from "../../server/routes.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listEffectiveSkillRegistryEntries, refreshEffectiveSkillRegistryEntries } from "./registry.js";
import { parseSkillImportDraftRequest } from "./schemas.js";

export async function handleSkillRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: SkillRoute | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (url.pathname === "/skills") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills` });
        return;
      }
      writeJson(response, 200, { cwd, skills: listEffectiveSkillRegistryEntries(store) });
      return;
    }

    if (url.pathname === "/skills/refresh") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/refresh` });
        return;
      }
      const refreshed = refreshEffectiveSkillRegistryEntries(store);
      writeJson(response, 200, { cwd, ...refreshed });
      return;
    }

    if (url.pathname === "/skills/import-draft") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /skills/import-draft` });
        return;
      }
      const body = await readJsonBody(request, config.maxBodyBytes);
      const draftInput = parseSkillImportDraftRequest(body, listEffectiveSkillRegistryEntries(store));
      const draft = store.createSkillImportDraft(draftInput, new Date().toISOString());
      writeJson(response, 201, { cwd, draft });
      return;
    }

    if (!route) {
      writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
      return;
    }

    if (route.kind === "draft") {
      if (request.method === "GET") {
        const draft = store.getSkillImportDraft(route.draftId);
        if (!draft) {
          writeJson(response, 404, { error: "skill_import_draft_not_found", message: `Skill import draft not found: ${route.draftId}` });
          return;
        }
        writeJson(response, 200, { cwd, draft });
        return;
      }
      if (request.method === "POST" && route.action === "publish") {
        const skills = store.publishSkillImportDraft(route.draftId, new Date().toISOString());
        writeJson(response, 200, { cwd, draftId: route.draftId, skills });
        return;
      }
    }

    if (route.kind === "skill" && request.method === "DELETE") {
      const archived = store.archiveSkillRegistryEntry(route.skillId, new Date().toISOString());
      if (!archived) {
        writeJson(response, 404, { error: "skill_not_found", message: `Skill not found: ${route.skillId}` });
        return;
      }
      writeJson(response, 200, { cwd, skill: archived });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for skill route` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
