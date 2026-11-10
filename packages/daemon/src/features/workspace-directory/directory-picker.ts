import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceDirectorySelectResponse } from "@ling-stack/contracts";
import { defineProtectedHostActorEntry } from "../../runtime/sandbox/protected-host-actor-inventory.js";

type ExecFileResult = {
  readonly stdout: string;
  readonly stderr: string;
};

type ExecFileOptions = {
  readonly encoding?: BufferEncoding;
  readonly maxBuffer?: number;
  readonly windowsHide?: boolean;
};

type ExecFileImpl = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
) => Promise<ExecFileResult>;

type StatImpl = typeof stat;

export type WorkspaceDirectoryPickerCode =
  | "directory_picker_unsupported"
  | "directory_picker_invalid_selection"
  | "directory_picker_failed";

export class WorkspaceDirectoryPickerError extends Error {
  readonly code: WorkspaceDirectoryPickerCode;
  readonly statusCode: number;

  constructor(code: WorkspaceDirectoryPickerCode, message: string, statusCode: number) {
    super(message);
    this.name = "WorkspaceDirectoryPickerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function selectWorkspaceDirectory(input: {
  readonly defaultPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly execFileImpl?: ExecFileImpl;
  readonly statImpl?: StatImpl;
} = {}): Promise<WorkspaceDirectorySelectResponse> {
  const platform = input.platform ?? process.platform;
  const execFileImpl = input.execFileImpl ?? execFileAsync;
  const statImpl = input.statImpl ?? stat;
  const defaultPath = normalizeDefaultPath(input.defaultPath);

  if (platform === "darwin") {
    const selected = await selectDirectoryWithAppleScript(defaultPath, execFileImpl);
    return selected ? toDirectoryResponse(selected, statImpl) : { cancelled: true };
  }

  if (platform === "win32") {
    const selected = await selectDirectoryWithPowerShell(defaultPath, execFileImpl);
    return selected ? toDirectoryResponse(selected, statImpl) : { cancelled: true };
  }

  if (platform === "linux") {
    const selected = await selectDirectoryWithLinuxDialog(defaultPath, execFileImpl);
    return selected ? toDirectoryResponse(selected, statImpl) : { cancelled: true };
  }

  throw new WorkspaceDirectoryPickerError(
    "directory_picker_unsupported",
    `Directory picker is not supported on ${platform}.`,
    501,
  );
}

async function selectDirectoryWithAppleScript(
  defaultPath: string | undefined,
  execFileImpl: ExecFileImpl,
): Promise<string | undefined> {
  const defaultLocation = defaultPath
    ? ` default location (POSIX file "${escapeAppleScriptString(defaultPath)}")`
    : "";
  const script = `set pickedFolder to choose folder with prompt "选择项目文件夹"${defaultLocation}
POSIX path of pickedFolder`;

  try {
    const result = await execFileImpl("osascript", ["-e", script], { encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    if (isAppleScriptCancel(error)) {
      return undefined;
    }
    throw pickerFailed(error, "macOS directory picker failed.");
  }
}

async function selectDirectoryWithPowerShell(
  defaultPath: string | undefined,
  execFileImpl: ExecFileImpl,
): Promise<string | undefined> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目文件夹'
$defaultPath = ${toPowerShellString(defaultPath ?? "")}
if ($defaultPath -and (Test-Path -LiteralPath $defaultPath -PathType Container)) {
  $dialog.SelectedPath = $defaultPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
} else {
  exit 2
}
`;

  try {
    const result = await execFileImpl("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (readProcessExitCode(error) === 2) {
      return undefined;
    }
    throw pickerFailed(error, "Windows directory picker failed.");
  }
}

async function selectDirectoryWithLinuxDialog(
  defaultPath: string | undefined,
  execFileImpl: ExecFileImpl,
): Promise<string | undefined> {
  if (await commandExists("zenity", execFileImpl)) {
    try {
      const result = await execFileImpl("zenity", [
        "--file-selection",
        "--directory",
        "--title=选择项目文件夹",
        ...(defaultPath ? [`--filename=${defaultPath}/`] : []),
      ], { encoding: "utf8" });
      return result.stdout.trim();
    } catch (error) {
      if (isLinuxDialogCancel(error)) {
        return undefined;
      }
      throw pickerFailed(error, "Linux zenity directory picker failed.");
    }
  }

  if (await commandExists("kdialog", execFileImpl)) {
    try {
      const result = await execFileImpl("kdialog", [
        "--getexistingdirectory",
        defaultPath ?? "",
        "--title",
        "选择项目文件夹",
      ], { encoding: "utf8" });
      return result.stdout.trim();
    } catch (error) {
      if (isLinuxDialogCancel(error)) {
        return undefined;
      }
      throw pickerFailed(error, "Linux kdialog directory picker failed.");
    }
  }

  throw new WorkspaceDirectoryPickerError(
    "directory_picker_unsupported",
    "No supported Linux directory picker was found. Install zenity or kdialog.",
    501,
  );
}

async function toDirectoryResponse(
  path: string,
  statImpl: StatImpl,
): Promise<WorkspaceDirectorySelectResponse> {
  const normalizedPath = normalizeSelectedPath(path);
  try {
    const info = await statImpl(normalizedPath);
    if (!info.isDirectory()) {
      throw new WorkspaceDirectoryPickerError(
        "directory_picker_invalid_selection",
        "Selected path is not a directory.",
        400,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceDirectoryPickerError) {
      throw error;
    }
    throw new WorkspaceDirectoryPickerError(
      "directory_picker_invalid_selection",
      "Selected directory does not exist.",
      400,
    );
  }

  return {
    cancelled: false,
    path: normalizedPath,
    label: basename(normalizedPath) || normalizedPath,
  };
}

async function commandExists(command: string, execFileImpl: ExecFileImpl): Promise<boolean> {
  try {
    await execFileImpl("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function normalizeDefaultPath(path: string | undefined): string | undefined {
  const trimmedPath = path?.trim();
  return trimmedPath && isAbsolute(trimmedPath) ? resolve(trimmedPath) : undefined;
}

function normalizeSelectedPath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath || !isAbsolute(trimmedPath)) {
    throw new WorkspaceDirectoryPickerError(
      "directory_picker_invalid_selection",
      "Selected directory must be an absolute path.",
      400,
    );
  }
  return resolve(trimmedPath);
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function isAppleScriptCancel(error: unknown): boolean {
  const text = readProcessErrorText(error);
  return text.includes("User canceled") || text.includes("用户已取消");
}

function isLinuxDialogCancel(error: unknown): boolean {
  return readProcessExitCode(error) === 1 && !readProcessErrorText(error).trim();
}

function pickerFailed(error: unknown, fallbackMessage: string): WorkspaceDirectoryPickerError {
  const message = readProcessErrorText(error).trim() || fallbackMessage;
  return new WorkspaceDirectoryPickerError("directory_picker_failed", message, 500);
}

function readProcessExitCode(error: unknown): number | undefined {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

function readProcessErrorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const record = error as { readonly stderr?: unknown; readonly stdout?: unknown; readonly message?: unknown };
  return [record.stderr, record.stdout, record.message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

const execFilePromise = promisify(execFile);

/** The original manual directory-picker producer; custom test implementations do not acquire its identity. */
export const workspaceDirectoryPickerActorEntry = defineProtectedHostActorEntry("workspace_directory_picker",
  async (file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<ExecFileResult> => {
  const result = await execFilePromise(file, [...args], {
    ...options,
    encoding: options.encoding ?? "utf8",
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
});

const execFileAsync: ExecFileImpl = (file, args, options) => workspaceDirectoryPickerActorEntry.invoke(undefined, file, args, options);
