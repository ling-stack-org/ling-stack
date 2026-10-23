import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import type { DesktopLocalFilePreview, DesktopLocalFileRequest } from "../../shared/local-file-capabilities.js";
import { DESKTOP_LOCAL_FILE_IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { inspectLocalFile } from "./preview.js";

const execute = promisify(execFile);
// The path travels as argv, never as executable AppleScript/JavaScript source.
const applicationQuery = `function run(argv) {
  ObjC.import('AppKit');
  var apps = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.fileURLWithPath(argv[0]));
  var result = [];
  for (var i = 0; i < Math.min(apps.count, 30); i++) {
    var path = ObjC.unwrap(apps.objectAtIndex(i).path);
    result.push({path: path, name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path))});
  }
  return JSON.stringify(result);
}`;

export async function localFileApplications(path: string): Promise<readonly { readonly path: string; readonly name: string }[]> {
  if (process.platform !== "darwin") return [];
  const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", applicationQuery, path], { timeout: 5_000, maxBuffer: 64 * 1024 });
  const entries: unknown = JSON.parse(stdout);
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is { path: string; name: string } => entry && typeof entry.path === "string" && entry.path.startsWith("/") && entry.path.endsWith(".app") && typeof entry.name === "string");
}

export function registerLocalFileIpc(input: {
  readonly ipcMainImpl: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly trustedDocumentUrl: string;
}): () => void {
  const assertSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = input.getMainWindow();
    const owner = window?.webContents;
    const actual = owner?.getURL();
    const expected = new URL(input.trustedDocumentUrl);
    const current = actual ? new URL(actual) : undefined;
    expected.hash = expected.search = "";
    if (current) current.hash = current.search = "";
    if (!window || window.isDestroyed() || !owner || owner.isDestroyed() || event.sender !== owner
      || !event.senderFrame || event.senderFrame !== owner.mainFrame || event.senderFrame.detached
      || event.senderFrame.url !== actual || current?.protocol !== "file:" || current.href !== expected.href) throw new Error("local_file_forbidden");
    return window;
  };
  for (const [operation, channel] of Object.entries(DESKTOP_LOCAL_FILE_IPC_CHANNELS)) {
    input.ipcMainImpl.handle(channel, async (event, value: unknown) => {
      assertSender(event);
      const request = readRequest(value);
      const preview = await inspectLocalFile(request);
      const window = assertSender(event);
      if (operation === "inspect") return preview;
      return showLocalFileMenu(window, preview, request, () => { assertSender(event); });
    });
  }
  return () => { for (const channel of Object.values(DESKTOP_LOCAL_FILE_IPC_CHANNELS)) input.ipcMainImpl.removeHandler(channel); };
}

function readRequest(value: unknown): DesktopLocalFileRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local_file_invalid_request");
  const request = value as Record<string, unknown>;
  if (typeof request.path !== "string" || (request.cwd !== undefined && typeof request.cwd !== "string")
    || (request.locale !== undefined && typeof request.locale !== "string")
    || (request.line !== undefined && (typeof request.line !== "number" || !Number.isSafeInteger(request.line) || request.line < 1))) throw new Error("local_file_invalid_request");
  return { path: request.path, cwd: request.cwd as string | undefined, locale: request.locale as string | undefined, line: request.line as number | undefined };
}

async function showLocalFileMenu(
  window: BrowserWindow,
  preview: DesktopLocalFilePreview,
  request: DesktopLocalFileRequest,
  assertCurrent: () => void,
): Promise<DesktopLocalFilePreview | undefined> {
  const { Menu, shell, dialog, clipboard } = createRequire(import.meta.url)("electron") as typeof import("electron");
  const zh = request.locale?.startsWith("zh") ?? false;
  const label = (en: string, chinese: string): string => zh ? chinese : en;
  let applications: Awaited<ReturnType<typeof localFileApplications>> = [];
  try { applications = await localFileApplications(preview.path); } catch { /* The system picker remains available when Launch Services fails. */ }
  assertCurrent();
  return new Promise((resolve) => {
    let selected = false;
    const action = (run: () => Promise<DesktopLocalFilePreview | undefined> | DesktopLocalFilePreview | undefined): (() => void) => () => {
      selected = true;
      void Promise.resolve().then(() => { assertCurrent(); return run(); }).then(resolve, (error: unknown) => {
        dialog.showErrorBox(label("Unable to open file", "无法操作文件"), error instanceof Error ? error.message : String(error));
        resolve(undefined);
      });
    };
    const openDefault = async (): Promise<undefined> => {
      const failure = await shell.openPath(preview.path);
      if (failure) throw new Error(failure);
      return undefined;
    };
    const chooseApplication = async (): Promise<undefined> => {
      if (process.platform === "win32") {
        await execute("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", preview.path], { timeout: 10_000 });
        return undefined;
      }
      const choice = await dialog.showOpenDialog(window, { title: label("Choose application", "选择打开应用"), defaultPath: process.platform === "darwin" ? "/Applications" : "/usr/bin", properties: ["openFile"] });
      if (!choice.canceled && choice.filePaths[0]) {
        assertCurrent();
        if (process.platform === "darwin") await execute("/usr/bin/open", ["-a", choice.filePaths[0], "--", preview.path]);
        else await execute(choice.filePaths[0], [preview.path], { timeout: 10_000 });
      }
      return undefined;
    };
    const template: MenuItemConstructorOptions[] = [
      { label: label("Preview in Ling", "在 Ling 中预览"), click: action(() => preview) },
      { label: label("Open in default application", "用默认应用打开"), click: action(openDefault) },
      { label: label("Open with", "打开方式"), submenu: [
        ...applications.map((application) => ({ label: application.name, click: action(async () => { await execute("/usr/bin/open", ["-a", application.path, "--", preview.path]); return undefined; }) })),
        ...(applications.length ? [{ type: "separator" as const }] : []),
        { label: label("Choose another application…", "选择其他应用…"), click: action(chooseApplication) },
      ] },
      { type: "separator" },
      { label: label("Save as…", "另存为…"), enabled: preview.kind !== "directory", click: action(async () => {
        const result = await dialog.showSaveDialog(window, { defaultPath: basename(preview.path) });
        if (!result.canceled && result.filePath && result.filePath !== preview.path) { assertCurrent(); await copyFile(preview.path, result.filePath); }
        return undefined;
      }) },
      { label: label("Copy path", "复制路径"), click: action(() => { clipboard.writeText(preview.path); return undefined; }) },
      ...(preview.kind === "text" && !preview.truncated ? [{ label: label("Copy file contents", "复制文件内容"), click: action(() => { clipboard.writeText(preview.text ?? ""); return undefined; }) }] : []),
      { label: label(process.platform === "darwin" ? "Show in Finder" : "Show in folder", process.platform === "darwin" ? "在 Finder 中显示" : "在文件夹中显示"), click: action(() => { shell.showItemInFolder(preview.path); return undefined; }) },
    ];
    Menu.buildFromTemplate(template).popup({ window, callback: () => { if (!selected) resolve(undefined); } });
  });
}
