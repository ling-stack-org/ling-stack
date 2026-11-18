import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { DesktopRuntime } from "../desktop-runtime.js";

/** Local identity verification and grant construction remain in the runtime. */
export function registerLockedControlIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly runtime: Pick<DesktopRuntime, "getLockedComputerControlState" | "authorizeLockedComputerControl" | "revokeLockedComputerControl">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly trustedDocumentUrl?: string;
}): () => void {
  const isTrusted = (event: IpcMainInvokeEvent): boolean => {
    try {
      const window = input.getMainWindow();
      const owner = window?.webContents;
      if (!window || window.isDestroyed() || !owner || owner.isDestroyed()
        || event.sender !== owner || !event.senderFrame || event.senderFrame !== owner.mainFrame
        || event.senderFrame.detached || event.senderFrame.url !== owner.getURL()
        || !input.trustedDocumentUrl) return false;
      const actual = new URL(owner.getURL());
      const expected = new URL(input.trustedDocumentUrl);
      actual.hash = expected.hash = "";
      actual.search = expected.search = "";
      return actual.protocol === "file:" && actual.href === expected.href;
    } catch { return false; }
  };
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.computerControlLockedState, async (event, ...args: unknown[]) => {
    if (args.length !== 0 || !isTrusted(event)) throw new Error("unauthorized_sender");
    try {
      const state = await input.runtime.getLockedComputerControlState();
      if (!isTrusted(event)) throw new Error("unauthorized_sender");
      return state;
    } catch {
      throw new Error("locked_control_state_unavailable");
    }
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.computerControlLockedAuthorize, async (event, ...args: unknown[]) => {
    if (args.length !== 0 || !isTrusted(event)) return { accepted: false, reason: "unauthorized_sender" };
    const result = await input.runtime.authorizeLockedComputerControl();
    if (!isTrusted(event)) {
      await input.runtime.revokeLockedComputerControl();
      return { accepted: false, reason: "unauthorized_sender" };
    }
    return result;
  });
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.computerControlLockedRevoke, async (event, ...args: unknown[]) => {
    if (args.length !== 0 || !isTrusted(event)) return { accepted: false, reason: "unauthorized_sender" };
    return input.runtime.revokeLockedComputerControl();
  });
  return () => {
    input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.computerControlLockedState);
    input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.computerControlLockedAuthorize);
    input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.computerControlLockedRevoke);
  };
}
