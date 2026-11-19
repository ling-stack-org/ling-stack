import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from "electron";
import type { DesktopWorktreeInitializationRequest } from "../../shared/worktree-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import type { DesktopWorktreeClient } from "./client.js";

export function registerWorktreeIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly trustedDocumentUrl: string;
  readonly client: Pick<DesktopWorktreeClient, "prepare" | "complete">;
  readonly showConfirmation?: (window: BrowserWindow, options: MessageBoxOptions) => Promise<{ readonly response: number }>;
}): () => void {
  const assertSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = input.getMainWindow(), owner = window?.webContents;
    try {
      const actual = new URL(owner?.getURL() ?? ""), expected = new URL(input.trustedDocumentUrl);
      actual.hash = actual.search = expected.hash = expected.search = "";
      if (!window || window.isDestroyed() || !owner || owner.isDestroyed() || event.sender !== owner
        || !event.senderFrame || event.senderFrame !== owner.mainFrame || event.senderFrame.detached
        || event.senderFrame.url !== owner.getURL() || actual.protocol !== "file:" || actual.href !== expected.href) throw new Error();
      return window;
    } catch { throw new Error("worktree_ipc_forbidden"); }
  };
  input.ipcMain.handle(DESKTOP_IPC_CHANNELS.worktreeInitialize, async (event, ...args: unknown[]) => {
    assertSender(event);
    if (args.length !== 1) throw new Error("worktree_request_invalid");
    const request = readRequest(args[0]);
    const challenge = await input.client.prepare(request);
    let confirmed = false;
    try {
      const window = assertSender(event);
      const zh = request.locale?.startsWith("zh") ?? false;
      const environment = challenge.environment;
      const confirm = input.showConfirmation ?? ((owner: BrowserWindow, options: MessageBoxOptions) =>
        (createRequire(import.meta.url)("electron") as typeof import("electron")).dialog.showMessageBox(owner, options));
      const result = await confirm(window, { type: "warning", title: zh ? "确认工作树初始化" : "Confirm worktree setup",
        message: zh ? `在 ${challenge.ownerName} 中运行初始化脚本？` : `Run the setup script for ${challenge.ownerName}?`,
        detail: [zh ? "脚本将使用你的账户权限运行。" : "The script runs with your account permissions.", challenge.path,
          environment?.enabled ? environment.setupScript : (zh ? "初始化脚本已关闭。" : "The setup script is disabled."),
          environment?.enabled ? `${zh ? "环境变量" : "Environment variables"}: ${environment.variableNames.join(", ") || "—"}` : "",
          environment?.enabled ? `${zh ? "超时" : "Timeout"}: ${environment.timeoutSeconds}s` : ""].filter(Boolean).join("\n\n"),
        buttons: zh ? ["取消", environment?.enabled ? "运行脚本" : "继续"]
          : ["Cancel", environment?.enabled ? "Run script" : "Continue"], defaultId: 0, cancelId: 0, noLink: true });
      assertSender(event);
      confirmed = result.response === 1;
    } catch (error) {
      await input.client.complete(request.cwd, challenge.challengeId, false).catch(() => undefined);
      throw error;
    }
    const result = await input.client.complete(request.cwd, challenge.challengeId, confirmed);
    assertSender(event);
    return confirmed ? result : undefined;
  });
  return () => input.ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.worktreeInitialize);
}

function readRequest(value: unknown): DesktopWorktreeInitializationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worktree_request_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["cwd", "ownerKind", "ownerId", "locale"].includes(key))
    || typeof record.cwd !== "string" || !isAbsolute(record.cwd) || record.cwd.length > 16_384
    || (record.ownerKind !== "channel" && record.ownerKind !== "teammate") || typeof record.ownerId !== "string"
    || !record.ownerId.trim() || record.ownerId.length > 512 || record.locale !== undefined && typeof record.locale !== "string") throw new Error("worktree_request_invalid");
  return { cwd: record.cwd, ownerKind: record.ownerKind, ownerId: record.ownerId, locale: record.locale as string | undefined };
}
