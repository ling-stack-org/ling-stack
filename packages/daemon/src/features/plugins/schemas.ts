import { isRecord, readOptionalObject, readOptionalString } from "../../shared/validation.js";

export function parseManagedPluginApplyPresetRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin preset request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginDisableRequest(value: unknown): { readonly reason?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Plugin disable request body must be an object.");
  }
  return {
    reason: readOptionalString(value, "reason"),
  };
}

export function parseManagedPluginValidatePackageRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin package validation request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginInstallRequest(value: unknown): { readonly options: Readonly<Record<string, unknown>> } {
  if (value === undefined || value === null) {
    return { options: {} };
  }
  if (!isRecord(value)) {
    throw new Error("Plugin install request body must be an object.");
  }
  return {
    options: readOptionalObject(value, "options") ?? {},
  };
}

export function parseManagedPluginUninstallRequest(value: unknown): { readonly reason?: string } {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Plugin uninstall request body must be an object.");
  }
  return {
    reason: readOptionalString(value, "reason"),
  };
}
