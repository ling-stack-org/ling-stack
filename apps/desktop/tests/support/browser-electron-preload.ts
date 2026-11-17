import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBrowserCapabilities } from "../../preload/browser.js";

contextBridge.exposeInMainWorld("lingDesktop", { browser: createDesktopBrowserCapabilities(ipcRenderer) });
