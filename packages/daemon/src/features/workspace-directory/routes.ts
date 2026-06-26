import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { writeJson } from "../../shared/response.js";
import {
  selectWorkspaceDirectory,
  WorkspaceDirectoryPickerError,
} from "./directory-picker.js";

export async function handleWorkspaceDirectorySelect(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (request.method !== "POST") {
    writeJson(response, 405, {
      error: "method_not_allowed",
      message: `${request.method} is not supported for workspace directory selection`,
    });
    return;
  }

  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    writeJson(response, 200, await selectWorkspaceDirectory({ defaultPath: cwd }));
  } catch (error) {
    if (error instanceof WorkspaceDirectoryPickerError) {
      writeJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    writeJson(response, 500, {
      error: "directory_picker_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
