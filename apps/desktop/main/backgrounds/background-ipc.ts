import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { BackgroundError, isBackgroundRequestId, parseCommitBackgroundRequest, parsePrepareBackgroundRequest,
  type BackgroundRepository } from "@ling-stack/ui-react/theme";
import { BACKGROUND_CHANNELS, type BackgroundReply } from "../../shared/background-capabilities.js";

export function registerBackgroundIpc(options: { repository: BackgroundRepository;
  getMainWindow: () => BrowserWindow | undefined; ipcMainImpl?: Pick<IpcMain, "handle" | "removeHandler"> }): () => void {
  const ipc = options.ipcMainImpl ?? (createRequire(import.meta.url)("electron") as { ipcMain: IpcMain }).ipcMain;
  const registered: string[] = [];
  const handle = (channel: string, operation: (args: unknown[]) => Promise<unknown>) => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<BackgroundReply<unknown>> => {
      try {
        const window = options.getMainWindow(), owner = window?.webContents;
        if (!window || window.isDestroyed() || !owner || owner.isDestroyed() || event.sender !== owner
          || event.sender.id !== owner.id || !event.senderFrame || event.senderFrame !== owner.mainFrame
          || !owner.getURL() || event.senderFrame.url !== owner.getURL()) throw new BackgroundError("invalid-request");
        return { ok: true, value: await operation(args) };
      } catch (error) { return { ok: false, error: error instanceof BackgroundError ? error.code : "unavailable" }; }
    });
    registered.push(channel);
  };
  const one = (args: unknown[]) => { if (args.length !== 1) throw new BackgroundError("invalid-request"); return args[0]; };
  try {
    handle(BACKGROUND_CHANNELS.read, args => { if (args.length) throw new BackgroundError("invalid-request"); return options.repository.read(); });
    handle(BACKGROUND_CHANNELS.prepare, args => options.repository.prepare(parsePrepareBackgroundRequest(one(args))));
    handle(BACKGROUND_CHANNELS.commit, args => options.repository.commit(parseCommitBackgroundRequest(one(args))));
    handle(BACKGROUND_CHANNELS.release, args => { const id = one(args); if (!isBackgroundRequestId(id)) throw new BackgroundError("invalid-request"); return options.repository.release(id); });
  } catch (error) { registered.forEach(channel => ipc.removeHandler(channel)); throw error; }
  return () => registered.forEach(channel => ipc.removeHandler(channel));
}
