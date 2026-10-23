import type { DesktopLocalFileCapabilities, DesktopLocalFileRequest } from "./local-file-capabilities.js";
import { DESKTOP_LOCAL_FILE_IPC_CHANNELS } from "./ipc-channels.js";

/** An API call alone cannot read host files: it must consume a real link gesture. */
export function createLocalFileCapabilities(
  invoke: (channel: string, request: DesktopLocalFileRequest) => Promise<unknown>,
  document: Document | undefined,
): DesktopLocalFileCapabilities {
  let activation: { path: string; cwd: string; expires: number } | undefined;
  const activate = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = event.target as Element | null;
    const link = typeof target?.closest === "function" ? target.closest<HTMLElement>("[data-local-file-path]") : null;
    activation = link ? {
      path: link.dataset.localFilePath ?? "",
      cwd: link.dataset.localFileCwd ?? "",
      expires: Date.now() + 1_000,
    } : undefined;
  };
  document?.addEventListener("click", activate, true);
  document?.addEventListener("contextmenu", activate, true);
  const consume = (request: DesktopLocalFileRequest): DesktopLocalFileRequest => {
    const current = activation;
    activation = undefined;
    if (!current || current.expires < Date.now() || current.path !== request.path || current.cwd !== (request.cwd ?? "")) {
      throw new Error("local_file_user_activation_required");
    }
    return { path: request.path, cwd: request.cwd, line: request.line, locale: request.locale };
  };
  return {
    inspect: async (request) => invoke(DESKTOP_LOCAL_FILE_IPC_CHANNELS.inspect, consume(request)) as ReturnType<DesktopLocalFileCapabilities["inspect"]>,
    showMenu: async (request) => invoke(DESKTOP_LOCAL_FILE_IPC_CHANNELS.menu, consume(request)) as ReturnType<DesktopLocalFileCapabilities["showMenu"]>,
  };
}
