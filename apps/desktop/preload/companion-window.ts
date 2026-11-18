import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import type { CompanionDesktopCapabilities } from "../shared/companion-capabilities.js";

const argument = (name: string): string => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const capabilities: CompanionDesktopCapabilities = {
  cwd: decodeURIComponent(argument("--ling-companion-cwd")),
  daemonBaseUrl: argument("--ling-daemon-base-url"),
  close: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowClose),
  openSettings: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowSettings),
};

contextBridge.exposeInMainWorld("lingCompanionDesktop", capabilities);
