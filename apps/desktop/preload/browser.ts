import type { IpcRenderer } from "electron";
import type { DesktopBrowserCapabilities } from "../shared/browser-capabilities.js";
import { DESKTOP_BROWSER_IPC_CHANNELS } from "../shared/ipc-channels.js";

export function createDesktopBrowserCapabilities(ipc: Pick<IpcRenderer, "invoke" | "send" | "on" | "off">): DesktopBrowserCapabilities {
  return {
    getState: workspace => ipc.invoke(DESKTOP_BROWSER_IPC_CHANNELS.state, workspace),
    act: request => ipc.invoke(DESKTOP_BROWSER_IPC_CHANNELS.act, request),
    reportViewport: viewport => ipc.send(DESKTOP_BROWSER_IPC_CHANNELS.viewport, viewport),
    onStateChanged: listener => {
      const wrapped = (): void => listener();
      ipc.on(DESKTOP_BROWSER_IPC_CHANNELS.changed, wrapped);
      return () => { ipc.off(DESKTOP_BROWSER_IPC_CHANNELS.changed, wrapped); };
    },
    onAddressFocusRequested: listener => {
      const wrapped = (): void => listener();
      ipc.on(DESKTOP_BROWSER_IPC_CHANNELS.focusAddress, wrapped);
      return () => { ipc.off(DESKTOP_BROWSER_IPC_CHANNELS.focusAddress, wrapped); };
    },
  };
}
