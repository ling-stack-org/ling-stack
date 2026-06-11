import type { IncomingMessage, ServerResponse } from "node:http";
import {
  channelAutoReplyModes,
  channelResponseLanguages,
  type Channel,
  type ChannelAutoReplyMode,
  type ChannelResponseLanguage,
  type RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { isRecord } from "../../shared/validation.js";
import { writeJson } from "../../shared/response.js";
import { resolveAiTeammateReference } from "../teammates/identity.js";

export type ChannelProtocolFieldSource =
  | "current_message"
  | "channel_setting"
  | "workspace_setting"
  | "default"
  | "teammate_instruction";

export interface ChannelProtocolFieldResolution<T> {
  readonly value: T;
  readonly source: ChannelProtocolFieldSource;
  readonly channelValue?: T;
  readonly workspaceValue?: T;
}

export interface EffectiveChannelCollaborationProtocol {
  readonly schemaVersion: 1;
  readonly channelId: string;
  readonly responseLanguage: ChannelResponseLanguage;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly defaultTeammateId?: string;
  readonly defaultWorkflowPreference: "manual";
  readonly visibleMultiReplyMaxParticipants: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly updatedBy: "local-user" | "system_template";
  readonly updatedAt: string;
}

export interface EffectiveChannelCollaborationProtocolResult {
  readonly protocol: EffectiveChannelCollaborationProtocol;
  readonly sources: {
    readonly responseLanguage: ChannelProtocolFieldResolution<ChannelResponseLanguage>;
    readonly autoReplyMode: ChannelProtocolFieldResolution<ChannelAutoReplyMode>;
    readonly defaultTeammateId: ChannelProtocolFieldResolution<string | undefined>;
    readonly defaultWorkflowPreference: ChannelProtocolFieldResolution<"manual">;
    readonly visibleMultiReplyMaxParticipants: ChannelProtocolFieldResolution<number>;
    readonly privacyRules: ChannelProtocolFieldResolution<readonly string[]>;
    readonly reviewRules: ChannelProtocolFieldResolution<readonly string[]>;
  };
  readonly storage: {
    readonly mode: "channel_fields";
    readonly editableFields: readonly string[];
    readonly unsupportedFields: readonly string[];
  };
}

const EDITABLE_PROTOCOL_FIELDS = ["responseLanguage", "autoReplyMode", "defaultTeammateId"] as const;
const UNSUPPORTED_PROTOCOL_FIELDS = [
  "defaultWorkflowPreference",
  "visibleMultiReplyMaxParticipants",
  "privacyRules",
  "reviewRules",
] as const;

type ProtocolPatchInput = {
  readonly responseLanguage?: ChannelResponseLanguage | null;
  readonly autoReplyMode?: ChannelAutoReplyMode | null;
  readonly defaultTeammateId?: string | null;
};

export function resolveEffectiveChannelCollaborationProtocol(input: {
  readonly store: RunStore;
  readonly channel: Channel;
}): EffectiveChannelCollaborationProtocolResult {
  const workspaceSettings = input.store.getWorkspaceSettings();
  const responseLanguage = resolveResponseLanguageField(input.channel, workspaceSettings.responseLanguage);
  const autoReplyMode = resolveAutoReplyModeField(input.channel);
  const defaultTeammateId = resolveDefaultTeammateField(input.channel);
  const defaultWorkflowPreference: ChannelProtocolFieldResolution<"manual"> = {
    value: "manual",
    source: "default",
  };
  const visibleMultiReplyMaxParticipants: ChannelProtocolFieldResolution<number> = {
    value: 3,
    source: "default",
  };
  const privacyRules: ChannelProtocolFieldResolution<readonly string[]> = {
    value: [],
    source: "default",
  };
  const reviewRules: ChannelProtocolFieldResolution<readonly string[]> = {
    value: [],
    source: "default",
  };

  return {
    protocol: {
      schemaVersion: 1,
      channelId: input.channel.id,
      responseLanguage: responseLanguage.value,
      autoReplyMode: autoReplyMode.value,
      defaultTeammateId: defaultTeammateId.value,
      defaultWorkflowPreference: defaultWorkflowPreference.value,
      visibleMultiReplyMaxParticipants: visibleMultiReplyMaxParticipants.value,
      privacyRules: privacyRules.value,
      reviewRules: reviewRules.value,
      updatedBy: responseLanguage.source === "default" &&
        autoReplyMode.source === "default" &&
        defaultTeammateId.source === "default"
        ? "system_template"
        : "local-user",
      updatedAt: input.channel.updatedAt,
    },
    sources: {
      responseLanguage,
      autoReplyMode,
      defaultTeammateId,
      defaultWorkflowPreference,
      visibleMultiReplyMaxParticipants,
      privacyRules,
      reviewRules,
    },
    storage: {
      mode: "channel_fields",
      editableFields: EDITABLE_PROTOCOL_FIELDS,
      unsupportedFields: UNSUPPORTED_PROTOCOL_FIELDS,
    },
  };
}

export async function handleChannelCollaborationProtocol(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  action?: "revert",
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (!action && request.method === "GET") {
      writeJson(response, 200, { cwd, ...resolveEffectiveChannelCollaborationProtocol({ store, channel }) });
      return;
    }

    if (!action && request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const patch = parseProtocolPatchInput(body);
      const validationError = validateProtocolPatch(store, patch, config);
      if (validationError) {
        writeJson(response, validationError.statusCode, {
          error: validationError.code,
          message: validationError.message,
        });
        return;
      }
      const updated = store.updateChannel(channelId, {
        responseLanguage: patch.responseLanguage,
        autoReplyMode: patch.autoReplyMode,
        defaultTeammateId: patch.defaultTeammateId,
      }, new Date().toISOString());
      writeJson(response, 200, {
        cwd,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel: updated ?? channel }),
      });
      return;
    }

    if (action === "revert" && request.method === "POST") {
      const updated = store.updateChannel(channelId, {
        responseLanguage: null,
        autoReplyMode: null,
        defaultTeammateId: null,
      }, new Date().toISOString());
      writeJson(response, 200, {
        cwd,
        revertedFields: EDITABLE_PROTOCOL_FIELDS,
        ...resolveEffectiveChannelCollaborationProtocol({ store, channel: updated ?? channel }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel protocol` });
  } catch (error) {
    if (error instanceof UnsupportedProtocolFieldError) {
      writeJson(response, 400, {
        error: "unsupported_protocol_field",
        message: error.message,
        field: error.field,
      });
      return;
    }
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveResponseLanguageField(
  channel: Channel,
  workspaceResponseLanguage: "follow_user" | "zh-CN" | "en-US" | undefined,
): ChannelProtocolFieldResolution<ChannelResponseLanguage> {
  if (channel.responseLanguage && channel.responseLanguage !== "workspace") {
    return {
      value: channel.responseLanguage,
      source: "channel_setting",
      channelValue: channel.responseLanguage,
      workspaceValue: workspaceResponseLanguage,
    };
  }
  if (workspaceResponseLanguage) {
    return {
      value: workspaceResponseLanguage,
      source: "workspace_setting",
      channelValue: channel.responseLanguage ?? "workspace",
      workspaceValue: workspaceResponseLanguage,
    };
  }
  return {
    value: "follow_user",
    source: "default",
    channelValue: channel.responseLanguage ?? "workspace",
  };
}

function resolveAutoReplyModeField(channel: Channel): ChannelProtocolFieldResolution<ChannelAutoReplyMode> {
  if (channel.autoReplyMode !== "mentions_only") {
    return {
      value: channel.autoReplyMode,
      source: "channel_setting",
      channelValue: channel.autoReplyMode,
    };
  }
  return {
    value: "mentions_only",
    source: "default",
    channelValue: channel.autoReplyMode,
  };
}

function resolveDefaultTeammateField(channel: Channel): ChannelProtocolFieldResolution<string | undefined> {
  if (channel.defaultTeammateId) {
    return {
      value: channel.defaultTeammateId,
      source: "channel_setting",
      channelValue: channel.defaultTeammateId,
    };
  }
  return {
    value: undefined,
    source: "default",
  };
}

function parseProtocolPatchInput(value: unknown): ProtocolPatchInput {
  if (!isRecord(value)) {
    throw new Error("Channel protocol patch must be a JSON object");
  }
  const unknownFields = Object.keys(value).filter((key) =>
    !EDITABLE_PROTOCOL_FIELDS.includes(key as typeof EDITABLE_PROTOCOL_FIELDS[number]) &&
    !UNSUPPORTED_PROTOCOL_FIELDS.includes(key as typeof UNSUPPORTED_PROTOCOL_FIELDS[number])
  );
  if (unknownFields.length > 0) {
    throw new Error(`Unsupported channel protocol field: ${unknownFields.join(", ")}`);
  }
  const unsupportedField = UNSUPPORTED_PROTOCOL_FIELDS.find((field) => value[field] !== undefined);
  if (unsupportedField) {
    throw new UnsupportedProtocolFieldError(unsupportedField);
  }
  return {
    responseLanguage: readNullableProtocolResponseLanguage(value, "responseLanguage"),
    autoReplyMode: readNullableProtocolAutoReplyMode(value, "autoReplyMode"),
    defaultTeammateId: readNullableProtocolString(value, "defaultTeammateId"),
  };
}

function validateProtocolPatch(
  store: RunStore,
  patch: ProtocolPatchInput,
  config: ResolvedDaemonConfig,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  if (patch.autoReplyMode === "auto_route" && !config.channels.autoRoute) {
    return { statusCode: 400, code: "auto_route_disabled", message: "Channel auto_route is disabled." };
  }
  if (patch.defaultTeammateId) {
    const teammate = resolveAiTeammateReference(store, patch.defaultTeammateId);
    if (!teammate) {
      return { statusCode: 400, code: "default_teammate_not_found", message: `Default teammate not found: ${patch.defaultTeammateId}` };
    }
    if (teammate.status !== "active" || teammate.hidden) {
      return { statusCode: 400, code: "default_teammate_not_available", message: `Default teammate is not available: ${patch.defaultTeammateId}` };
    }
  }
  return undefined;
}

function readNullableProtocolResponseLanguage(record: Record<string, unknown>, key: string): ChannelResponseLanguage | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !channelResponseLanguages.includes(value as ChannelResponseLanguage)) {
    throw new Error(`${key} must be one of: ${channelResponseLanguages.join(", ")}, or null`);
  }
  return value as ChannelResponseLanguage;
}

function readNullableProtocolAutoReplyMode(record: Record<string, unknown>, key: string): ChannelAutoReplyMode | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !channelAutoReplyModes.includes(value as ChannelAutoReplyMode)) {
    throw new Error(`${key} must be one of: ${channelAutoReplyModes.join(", ")}, or null`);
  }
  return value as ChannelAutoReplyMode;
}

function readNullableProtocolString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string or null`);
  }
  return value;
}

class UnsupportedProtocolFieldError extends Error {
  constructor(readonly field: string) {
    super(`Protocol field is not editable in P7B1: ${field}`);
    this.name = "UnsupportedProtocolFieldError";
  }
}
