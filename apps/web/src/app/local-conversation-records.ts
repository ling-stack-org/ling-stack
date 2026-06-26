import type { PermissionPreset, ProviderThinkingMode, SessionPermissionMode } from "../types.js";

export interface LocalConversationRecord {
  readonly id: string;
  readonly label: string;
  readonly draft: string;
  readonly messages: readonly LocalConversationMessage[];
  readonly projectPath?: string;
  readonly projectLabel?: string;
  readonly providerPresetId?: string;
  readonly thinkingLevel?: ProviderThinkingMode;
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset: PermissionPreset;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalConversationMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
  readonly createdAt: string;
}

export interface LocalConversationProjectSelection {
  readonly projectPath?: string;
  readonly projectLabel?: string;
}

export interface LocalConversationModelSelection {
  readonly providerPresetId?: string;
  readonly thinkingLevel?: ProviderThinkingMode;
}

export interface LocalConversationAuthorizationSelection {
  readonly permissionMode?: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
}

const storageKey = "ling-stack.conversationRecords.v1";
const maxRecords = 20;
const providerThinkingModes = new Set<ProviderThinkingMode>(["off", "minimal", "low", "medium", "high", "xhigh"]);
const sessionPermissionModes = new Set<SessionPermissionMode>(["ask_everything", "balanced", "workspace_write", "full_access", "custom"]);
const permissionPresets = new Set<PermissionPreset>(["read_only", "workspace_collaboration", "full_access", "custom"]);
const defaultConversationPermissionMode: SessionPermissionMode = "workspace_write";
const defaultConversationPermissionPreset: PermissionPreset = "workspace_collaboration";

export function readLocalConversationRecords(): readonly LocalConversationRecord[] {
  const storage = readStorage();
  if (!storage) {
    return [];
  }

  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map(readRecord)
      .filter((record): record is LocalConversationRecord => Boolean(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, maxRecords);
  } catch {
    return [];
  }
}

export function writeLocalConversationRecords(records: readonly LocalConversationRecord[]): void {
  const storage = readStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(storageKey, JSON.stringify(records.slice(0, maxRecords)));
  } catch {
    // Ignore storage failures; the current in-memory session still works.
  }
}

export function upsertLocalConversationRecord(
  records: readonly LocalConversationRecord[],
  draft: string,
  selectedRecordId: string,
  project: LocalConversationProjectSelection = {},
  model: LocalConversationModelSelection = {},
  authorization: LocalConversationAuthorizationSelection = {
    permissionMode: defaultConversationPermissionMode,
    permissionPreset: defaultConversationPermissionPreset,
  },
  now = new Date().toISOString(),
): {
  readonly records: readonly LocalConversationRecord[];
  readonly selectedRecordId: string;
} {
  const trimmedDraft = draft.trim();
  const existingRecord = records.find((record) => record.id === selectedRecordId);
  const recordId = existingRecord?.id ?? createLocalConversationRecordId();
  const projectPath = project.projectPath?.trim() || undefined;
  const projectLabel = project.projectLabel?.trim() || (projectPath ? summarizeProjectPath(projectPath) : undefined);
  const providerPresetId = model.providerPresetId?.trim() || undefined;
  const thinkingLevel = readThinkingLevel(model.thinkingLevel);
  const permissionMode = readPermissionMode(authorization.permissionMode) ?? existingRecord?.permissionMode ?? defaultConversationPermissionMode;
  const permissionPreset = readPermissionPreset(authorization.permissionPreset) ?? existingRecord?.permissionPreset ?? inferPermissionPreset(permissionMode);
  const nextMessages = [
    ...(existingRecord?.messages ?? []),
    {
      id: createLocalConversationMessageId(),
      role: "user" as const,
      content: trimmedDraft,
      createdAt: now,
    },
  ];
  const nextRecord: LocalConversationRecord = {
    id: recordId,
    label: existingRecord?.label ?? summarizeConversationDraft(trimmedDraft),
    draft: "",
    messages: nextMessages,
    ...(projectPath ? { projectPath, projectLabel } : {}),
    ...(providerPresetId ? { providerPresetId } : {}),
    ...(thinkingLevel && thinkingLevel !== "off" ? { thinkingLevel } : {}),
    permissionMode,
    permissionPreset,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
  };
  const nextRecords = [
    nextRecord,
    ...records.filter((record) => record.id !== recordId),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, maxRecords);

  return {
    records: nextRecords,
    selectedRecordId: recordId,
  };
}

function readStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): LocalConversationRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<LocalConversationRecord>;
  if (
    typeof record.id !== "string" ||
    typeof record.label !== "string" ||
    typeof record.draft !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    label: record.label,
    draft: record.draft,
    messages: readMessages(record.messages, record.draft, record.updatedAt),
    projectPath: typeof record.projectPath === "string" && record.projectPath.trim() ? record.projectPath : undefined,
    projectLabel: typeof record.projectLabel === "string" && record.projectLabel.trim() ? record.projectLabel : undefined,
    providerPresetId: typeof record.providerPresetId === "string" && record.providerPresetId.trim() ? record.providerPresetId : undefined,
    thinkingLevel: readThinkingLevel(record.thinkingLevel),
    permissionMode: readPermissionMode(record.permissionMode) ?? defaultConversationPermissionMode,
    permissionPreset: readPermissionPreset(record.permissionPreset) ?? inferPermissionPreset(readPermissionMode(record.permissionMode) ?? defaultConversationPermissionMode),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function readMessages(value: unknown, legacyDraft: string, fallbackCreatedAt: string): readonly LocalConversationMessage[] {
  if (Array.isArray(value)) {
    const messages = value
      .map(readMessage)
      .filter((message): message is LocalConversationMessage => Boolean(message));
    if (messages.length > 0) {
      return messages;
    }
  }
  const trimmedDraft = legacyDraft.trim();
  return trimmedDraft
    ? [{
      id: createLocalConversationMessageId(),
      role: "user",
      content: trimmedDraft,
      createdAt: fallbackCreatedAt,
    }]
    : [];
}

function readMessage(value: unknown): LocalConversationMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const message = value as Partial<LocalConversationMessage>;
  if (
    typeof message.id !== "string" ||
    message.role !== "user" ||
    typeof message.content !== "string" ||
    !message.content.trim() ||
    typeof message.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    id: message.id,
    role: "user",
    content: message.content,
    createdAt: message.createdAt,
  };
}

function readThinkingLevel(value: unknown): ProviderThinkingMode | undefined {
  return typeof value === "string" && providerThinkingModes.has(value as ProviderThinkingMode)
    ? value as ProviderThinkingMode
    : undefined;
}

function readPermissionMode(value: unknown): SessionPermissionMode | undefined {
  return typeof value === "string" && sessionPermissionModes.has(value as SessionPermissionMode)
    ? value as SessionPermissionMode
    : undefined;
}

function readPermissionPreset(value: unknown): PermissionPreset | undefined {
  return typeof value === "string" && permissionPresets.has(value as PermissionPreset)
    ? value as PermissionPreset
    : undefined;
}

function inferPermissionPreset(mode: SessionPermissionMode): PermissionPreset {
  if (mode === "ask_everything") {
    return "read_only";
  }
  if (mode === "workspace_write") {
    return "workspace_collaboration";
  }
  if (mode === "full_access") {
    return "full_access";
  }
  return "custom";
}

function summarizeConversationDraft(draft: string): string {
  const firstLine = draft.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "New conversation";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}...` : firstLine;
}

function createLocalConversationRecordId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `conversation:${globalThis.crypto.randomUUID()}`;
  }
  return `conversation:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function createLocalConversationMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `message:${globalThis.crypto.randomUUID()}`;
  }
  return `message:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeProjectPath(path: string): string {
  const normalizedPath = path.replace(/[\\/]+$/u, "");
  const label = normalizedPath.split(/[\\/]/u).filter(Boolean).at(-1);
  return label || path;
}
