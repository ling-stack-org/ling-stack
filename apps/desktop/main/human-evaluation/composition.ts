import type { BrowserWindow, PowerMonitor } from "electron";
import { HumanEvaluationCoordinator } from "./coordinator.js";
import { createHumanEvaluationDaemonClient } from "./daemon-client.js";
import { registerHumanEvaluationIpc } from "./ipc.js";
import { createHumanEvaluationNativeBridge, resolveHumanEvaluationHelper } from "./native-bridge.js";
import { createHumanEvaluationWorkspaceScope } from "./workspace-scope.js";

/** Independent Main composition: neither CU gates nor an active Run authorize human feedback. */
export function createHumanEvaluationDesktopComposition(options: {
  readonly daemonBaseUrl: string; readonly bridgeToken: string; readonly desktopInstanceId: string;
  readonly workspaceCwd: string; readonly resourcesRoot: string; readonly knownAppUrl: string;
  readonly packaged: boolean; readonly getMainWindow: () => BrowserWindow | undefined;
  readonly powerMonitor: PowerMonitor;
}): { bindOwner(window: BrowserWindow): void; dispose(): Promise<void> } {
  let coordinator: HumanEvaluationCoordinator | undefined;
  if (options.packaged && process.platform === "darwin") {
    // Missing or non-executable packaged helper leaves the capability unavailable, never token-only.
    try {
      const scope = createHumanEvaluationWorkspaceScope(options.workspaceCwd);
      coordinator = new HumanEvaluationCoordinator({ desktopInstanceId: options.desktopInstanceId,
        workspaceCwd: scope.canonicalWorkspaceCwd, displayWorkspaceCwd: scope.workspaceCwd, scopeCurrent: scope.current,
        native: createHumanEvaluationNativeBridge({ helperPath: resolveHumanEvaluationHelper(options.resourcesRoot) }),
        daemon: createHumanEvaluationDaemonClient({ daemonBaseUrl: options.daemonBaseUrl, bridgeToken: options.bridgeToken }) });
    } catch { /* Fail closed; IPC returns native_unavailable. */ }
  }
  const unregister = registerHumanEvaluationIpc({ coordinator, knownAppUrl: options.knownAppUrl,
    getMainWindow: options.getMainWindow });
  const invalidate = (): void => coordinator?.invalidate();
  options.powerMonitor.on("lock-screen", invalidate);
  options.powerMonitor.on("unlock-screen", invalidate);
  options.powerMonitor.on("suspend", invalidate);
  options.powerMonitor.on("resume", invalidate);
  options.powerMonitor.on("user-did-resign-active", invalidate);
  options.powerMonitor.on("user-did-become-active", invalidate);
  const cleanups: (() => void)[] = [];
  return {
    bindOwner(window) {
      const contents = window.webContents;
      const navigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean): void => {
        if (mainFrame) invalidate();
      };
      contents.on("did-start-navigation", navigate);
      contents.on("render-process-gone", invalidate);
      contents.on("destroyed", invalidate);
      cleanups.push(() => {
        contents.removeListener("did-start-navigation", navigate);
        contents.removeListener("render-process-gone", invalidate);
        contents.removeListener("destroyed", invalidate);
      });
    },
    async dispose() {
      unregister();
      options.powerMonitor.removeListener("lock-screen", invalidate);
      options.powerMonitor.removeListener("unlock-screen", invalidate);
      options.powerMonitor.removeListener("suspend", invalidate);
      options.powerMonitor.removeListener("resume", invalidate);
      options.powerMonitor.removeListener("user-did-resign-active", invalidate);
      options.powerMonitor.removeListener("user-did-become-active", invalidate);
      for (const cleanup of cleanups) cleanup();
      await coordinator?.dispose();
    },
  };
}
