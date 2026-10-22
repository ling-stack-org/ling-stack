import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { isExecutionEngineSecretValue, type ExecutionEngineLoginMethod, type ExternalExecutionEngineId, type SaveExecutionEngineProfileRequest, type SaveExecutionEngineSecretRequest } from "@ling-stack/contracts";
import type { DesktopExecutionEngineCapabilities } from "../../shared/desktop-capabilities.js";
import { DESKTOP_IPC_CHANNELS } from "../../shared/ipc-channels.js";

export function registerExecutionEngineIpc(input: {
  readonly ipcMainImpl: Pick<IpcMain, "handle" | "removeHandler">;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly trustedDocumentUrl: string;
  readonly getClient: () => Promise<DesktopExecutionEngineCapabilities>;
}): () => void {
  const registered: string[] = [];
  const bind = (channel: string, prepare: (args: readonly unknown[]) => (client: DesktopExecutionEngineCapabilities) => Promise<unknown>): void => {
    registered.push(channel);
    input.ipcMainImpl.handle(channel, async (event, ...args) => {
      try {
        assertSender(input, event);
        const operation = prepare(args);
        const client = await input.getClient();
        assertSender(input, event);
        const result = await operation(client);
        assertSender(input, event);
        return result;
      } catch (error) {
        // Electron preserves error messages, not custom error fields. Return only a stable code.
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code
          : error instanceof Error ? error.message : "engine_operation_failed";
        throw new Error(/^(engine|profile)_[a-z_]+$/.test(code) ? code : "engine_operation_failed");
      }
    });
  };
  bind(DESKTOP_IPC_CHANNELS.executionEnginesList, (args) => {
    if (args.length !== 0) invalid();
    return (client) => client.listProfiles();
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineProfileGet, (args) => {
    if (args.length !== 1) invalid();
    const engineId = readEngineId(args[0]);
    return (client) => client.getProfile(engineId);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineProfileSave, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const request = readSave(args[1], engineId);
    return (client) => client.saveProfile(engineId, request);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineProfileDisconnect, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const revision = readRevision(args[1]);
    return (client) => client.disconnectProfile(engineId, revision);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineProfileSecretSave, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const value = args[1];
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["configuration", "expectedRevision", "secret"].includes(key))
      || !isExecutionEngineSecretValue(record.secret)) invalid();
    const profile = readSave({ configuration: record.configuration, expectedRevision: record.expectedRevision }, engineId);
    if ("secretRef" in profile.configuration) invalid();
    const request: SaveExecutionEngineSecretRequest = { ...profile, secret: record.secret };
    return (client) => client.saveProfileWithSecret(engineId, request);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineProfileProbe, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const revision = readRevision(args[1]);
    return (client) => client.probeProfile(engineId, revision);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineConnectionProbe, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const revision = readRevision(args[1]);
    return (client) => client.probeConnection(engineId, revision);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineLoginStart, (args) => {
    if (args.length !== 3) invalid();
    const engineId = readEngineId(args[0]);
    const revision = readRevision(args[1]);
    const method = readLoginMethod(args[2]);
    return (client) => client.startLogin(engineId, revision, method);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineLoginGet, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const operationId = readOperationId(args[1]);
    return (client) => client.getLogin(engineId, operationId);
  });
  bind(DESKTOP_IPC_CHANNELS.executionEngineLoginCancel, (args) => {
    if (args.length !== 2) invalid();
    const engineId = readEngineId(args[0]);
    const operationId = readOperationId(args[1]);
    return (client) => client.cancelLogin(engineId, operationId);
  });
  return () => { for (const channel of registered) input.ipcMainImpl.removeHandler(channel); };
}

function assertSender(input: { readonly getMainWindow: () => BrowserWindow | undefined; readonly trustedDocumentUrl: string }, event: IpcMainInvokeEvent): void {
  const window = input.getMainWindow();
  const owner = window?.webContents;
  if (!window || window.isDestroyed() || !owner || owner.isDestroyed() || event.sender !== owner
    || event.sender.id !== owner.id || event.sender.isDestroyed() || !event.senderFrame
    || event.senderFrame !== owner.mainFrame || event.senderFrame.detached
    || event.senderFrame.url !== owner.getURL() || !sameDocument(owner.getURL(), input.trustedDocumentUrl)) {
    throw new Error("engine_ipc_forbidden");
  }
}

function sameDocument(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    a.hash = b.hash = "";
    a.search = b.search = "";
    return a.protocol === "file:" && a.href === b.href;
  } catch { return false; }
}

function readEngineId(value: unknown): ExternalExecutionEngineId {
  if (typeof value !== "string" || !["codex-app-server", "claude-agent-sdk", "kimi-acp", "openclaw-acp"].includes(value)) invalid();
  return value as ExternalExecutionEngineId;
}

function readRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function readLoginMethod(value: unknown): ExecutionEngineLoginMethod {
  if (value !== "chatgpt" && value !== "chatgptDeviceCode" && value !== "apiKey" && value !== "terminal") invalid();
  return value;
}

function readOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value;
}

function readSave(value: unknown, engineId: ExternalExecutionEngineId): SaveExecutionEngineProfileRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["configuration", "expectedRevision"].includes(key))) invalid();
  readRevision(record.expectedRevision);
  if (!record.configuration || typeof record.configuration !== "object" || Array.isArray(record.configuration)
    || !("engineId" in record.configuration) || record.configuration.engineId !== engineId) invalid();
  try { if (JSON.stringify(value).length > 32_768) invalid(); } catch { invalid(); }
  return value as SaveExecutionEngineProfileRequest;
}

function invalid(): never { throw new Error("engine_request_invalid"); }
