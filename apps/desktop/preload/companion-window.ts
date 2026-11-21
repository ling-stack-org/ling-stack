import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC_CHANNELS } from "../shared/ipc-channels.js";
import type { CompanionDesktopCapabilities } from "../shared/companion-capabilities.js";

const argument = (name: string): string => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const capabilities: CompanionDesktopCapabilities = {
  cwd: decodeURIComponent(argument("--ling-companion-cwd")),
  daemonBaseUrl: argument("--ling-daemon-base-url"),
  close: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowClose),
  openSettings: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowSettings),
  getGeometry: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowGeometryGet),
  onGeometryChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, geometry: import("../shared/companion-capabilities.js").CompanionWindowGeometry) => listener(geometry);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.companionGeometryChanged, wrapped);
    return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.companionGeometryChanged, wrapped);
  },
  setLayout: (request) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowLayout, request),
  navigate: (request) => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.companionWindowNavigate, request),
  onSourceRequested: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, request: import("../shared/companion-capabilities.js").CompanionNavigationRequest) => listener(request);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.companionNavigationRequested, wrapped);
    return () => ipcRenderer.off(DESKTOP_IPC_CHANNELS.companionNavigationRequested, wrapped);
  },
};

contextBridge.exposeInMainWorld("lingCompanionDesktop", capabilities);
