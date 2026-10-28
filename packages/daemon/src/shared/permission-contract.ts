import { HttpError } from "../errors.js";

export const LEGACY_PERMISSION_FIELDS = [
  "defaultPermissionMode",
  "defaultPermissionPreset",
  "permissionMode",
  "permissionPreset",
] as const;

/** Enforces the v2 boundary while leaving unversioned/v1 historical callers readable. */
export function assertPermissionContractVersion(value: unknown): void {
  if (!isRecord(value)) return;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === 1) return;
  if (schemaVersion !== 2) {
    throw new HttpError(400, "unsupported_permission_schema_version", "Permission requests must use schemaVersion 1 or 2.");
  }
  if (LEGACY_PERMISSION_FIELDS.some((key) => value[key] !== undefined)) {
    throw new HttpError(400, "legacy_permission_fields_removed", "schemaVersion 2 accepts authorizationMode and workspaceAccessMode only.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
