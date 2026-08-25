export const OFFICE_DOCUMENTS_PLUGIN_ID = "built-in:office-documents" as const;
export const OFFICE_DOCUMENTS_MCP_SERVER_ID = "mcp_office_documents" as const;
export const OFFICE_DRIVER_PROTOCOL = "ling.office.driver.v1" as const;
export const OFFICE_DRIVER_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const OFFICE_DRIVER_MAX_RESULT_BYTES = 8 * 1024 * 1024;

export const officeDocumentToolNames = [
  "office_inspect_document",
  "office_create_workbook",
  "office_edit_workbook",
  "office_create_document",
  "office_edit_document",
  "office_create_presentation",
  "office_edit_presentation",
  "office_render_document",
  "office_validate_document",
] as const;

export const officeLiveToolNames = [
  "office_list_sessions",
  "office_read_ranges",
  "office_search_workbook",
  "office_write_range",
  "office_update_sheet",
  "office_format_range",
  "office_save_workbook",
  "office_save_workbook_as",
  "office_create_table",
  "office_create_chart",
  "office_apply_filter",
  "office_resize_range",
] as const;

export const officeDriverMethods = [
  "driver_status",
  "list_sessions",
  "read_ranges",
  "search_workbook",
  "write_range",
  "update_sheet",
  "format_range",
  "save_workbook",
  "save_workbook_as",
  "create_table",
  "create_chart",
  "apply_filter",
  "resize_range",
] as const;

export const officeDriverCapabilities = [
  "excel:sessions",
  "excel:read",
  "excel:search",
  "excel:write",
  "excel:sheets",
  "excel:format-basic",
  "excel:save",
  "excel:save-as",
  "excel:tables",
  "excel:charts",
  "excel:filters",
  "excel:resize",
] as const;

export type OfficeDocumentToolName = (typeof officeDocumentToolNames)[number];
export type OfficeLiveToolName = (typeof officeLiveToolNames)[number];
export type OfficeDriverMethod = (typeof officeDriverMethods)[number];
export type OfficeDriverCapability = (typeof officeDriverCapabilities)[number];
export type OfficeDriverPlatform = "darwin" | "win32";
export type OfficeDocumentKind = "xlsx" | "docx" | "pptx";

export type OfficeDocumentsSetupState =
  | "not_installed"
  | "disabled"
  | "office_missing"
  | "permission_required"
  | "application_not_running"
  | "ready"
  | "limited"
  | "driver_error"
  | "desktop_required";

export type OfficeDriverRuntimeState =
  | "ready"
  | "office_missing"
  | "permission_required"
  | "application_not_running"
  | "limited"
  | "driver_error";

export interface OfficeLiveSession {
  readonly id: string;
  readonly generation: number;
  readonly platform: OfficeDriverPlatform;
  readonly application: "excel";
  readonly workbookName: string;
  readonly workbookPath?: string;
  readonly activeSheet?: string;
  readonly readOnly: boolean;
  readonly dirty: boolean;
  readonly capabilities: readonly OfficeDriverCapability[];
}

export interface OfficeDriverAvailability {
  readonly protocol: typeof OFFICE_DRIVER_PROTOCOL;
  readonly generation: number;
  readonly desktopInstanceId: string;
  readonly platform: OfficeDriverPlatform;
  readonly helperVersion: string;
  readonly state: OfficeDriverRuntimeState;
  readonly capabilities: readonly OfficeDriverCapability[];
  readonly officeInstalled: boolean;
  readonly applicationRunning: boolean;
  readonly permissionGranted?: boolean;
  readonly errorCode?: string;
  readonly checkedAt: string;
}

export interface OfficeDriverRequest {
  readonly protocol: typeof OFFICE_DRIVER_PROTOCOL;
  readonly id: string;
  readonly method: OfficeDriverMethod;
  readonly params: unknown;
  readonly deadlineAt: string;
  readonly idempotencyKey: string;
}

export interface OfficeDriverResult {
  readonly protocol: typeof OFFICE_DRIVER_PROTOCOL;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface OfficeDriverClaimResponse {
  readonly command?: OfficeDriverRequest;
}

export function isOfficeDocumentToolName(value: unknown): value is OfficeDocumentToolName {
  return typeof value === "string" && (officeDocumentToolNames as readonly string[]).includes(value);
}

export function isOfficeLiveToolName(value: unknown): value is OfficeLiveToolName {
  return typeof value === "string" && (officeLiveToolNames as readonly string[]).includes(value);
}

export function isOfficeDriverMethod(value: unknown): value is OfficeDriverMethod {
  return typeof value === "string" && (officeDriverMethods as readonly string[]).includes(value);
}

export function parseOfficeDriverAvailability(value: unknown): OfficeDriverAvailability {
  const record = readRecord(value, "Office driver availability");
  assertExactKeys(record, [
    "protocol",
    "generation",
    "desktopInstanceId",
    "platform",
    "helperVersion",
    "state",
    "capabilities",
    "officeInstalled",
    "applicationRunning",
    "permissionGranted",
    "errorCode",
    "checkedAt",
  ]);
  assertProtocol(record.protocol);
  const platform = readPlatform(record.platform);
  const state = readRuntimeState(record.state);
  const capabilities = readCapabilities(record.capabilities, platform);
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    generation: readPositiveInteger(record.generation, "generation"),
    desktopInstanceId: readBoundedString(record.desktopInstanceId, "desktopInstanceId", 128),
    platform,
    helperVersion: readBoundedString(record.helperVersion, "helperVersion", 64),
    state,
    capabilities,
    officeInstalled: readBoolean(record.officeInstalled, "officeInstalled"),
    applicationRunning: readBoolean(record.applicationRunning, "applicationRunning"),
    ...(record.permissionGranted === undefined
      ? {}
      : { permissionGranted: readBoolean(record.permissionGranted, "permissionGranted") }),
    ...(record.errorCode === undefined
      ? {}
      : { errorCode: readBoundedString(record.errorCode, "errorCode", 96) }),
    checkedAt: readIsoTimestamp(record.checkedAt, "checkedAt"),
  };
}

export function parseOfficeDriverRequest(value: unknown): OfficeDriverRequest {
  const record = readRecord(value, "Office driver request");
  assertExactKeys(record, ["protocol", "id", "method", "params", "deadlineAt", "idempotencyKey"]);
  assertProtocol(record.protocol);
  if (!isOfficeDriverMethod(record.method)) throw new Error("Unsupported Office driver method.");
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    id: readBoundedString(record.id, "id", 128),
    method: record.method,
    params: record.params ?? {},
    deadlineAt: readIsoTimestamp(record.deadlineAt, "deadlineAt"),
    idempotencyKey: readBoundedString(record.idempotencyKey, "idempotencyKey", 256),
  };
}

export function parseOfficeDriverResult(value: unknown): OfficeDriverResult {
  const record = readRecord(value, "Office driver result");
  assertExactKeys(record, ["protocol", "id", "ok", "result", "error"]);
  assertProtocol(record.protocol);
  const ok = readBoolean(record.ok, "ok");
  const error = record.error === undefined ? undefined : parseDriverError(record.error);
  if (ok && error) throw new Error("Successful Office driver result cannot include an error.");
  if (!ok && !error) throw new Error("Failed Office driver result must include an error.");
  return {
    protocol: OFFICE_DRIVER_PROTOCOL,
    id: readBoundedString(record.id, "id", 128),
    ok,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(error ? { error } : {}),
  };
}

export function officeMethodForTool(toolName: OfficeLiveToolName): OfficeDriverMethod {
  const method = toolName.slice("office_".length);
  if (!isOfficeDriverMethod(method)) throw new Error(`Office live tool has no driver method: ${toolName}`);
  return method;
}

function parseDriverError(value: unknown): { readonly code: string; readonly message: string } {
  const record = readRecord(value, "Office driver error");
  assertExactKeys(record, ["code", "message"]);
  return {
    code: readBoundedString(record.code, "error.code", 96),
    message: readBoundedString(record.message, "error.message", 512),
  };
}

function readCapabilities(value: unknown, platform: OfficeDriverPlatform): readonly OfficeDriverCapability[] {
  if (!Array.isArray(value) || value.length > officeDriverCapabilities.length) {
    throw new Error("capabilities must be a bounded array.");
  }
  const unique = new Set<OfficeDriverCapability>();
  for (const capability of value) {
    if (typeof capability !== "string" || !(officeDriverCapabilities as readonly string[]).includes(capability)) {
      throw new Error(`Unsupported Office driver capability: ${String(capability)}`);
    }
    if (unique.has(capability as OfficeDriverCapability)) throw new Error("Duplicate Office driver capability.");
    unique.add(capability as OfficeDriverCapability);
  }
  const windowsOnly = new Set<OfficeDriverCapability>([
    "excel:tables",
    "excel:charts",
    "excel:filters",
    "excel:resize",
  ]);
  if (platform === "darwin" && [...unique].some((capability) => windowsOnly.has(capability))) {
    throw new Error("macOS Office driver cannot advertise Windows-only capabilities.");
  }
  return [...unique];
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertProtocol(value: unknown): void {
  if (value !== OFFICE_DRIVER_PROTOCOL) throw new Error("Unsupported Office driver protocol.");
}

function readPlatform(value: unknown): OfficeDriverPlatform {
  if (value !== "darwin" && value !== "win32") throw new Error("Unsupported Office driver platform.");
  return value;
}

function readRuntimeState(value: unknown): OfficeDriverRuntimeState {
  if (
    value !== "ready"
    && value !== "office_missing"
    && value !== "permission_required"
    && value !== "application_not_running"
    && value !== "limited"
    && value !== "driver_error"
  ) throw new Error("Unsupported Office driver runtime state.");
  return value;
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer.`);
  return value as number;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function readIsoTimestamp(value: unknown, field: string): string {
  const timestamp = readBoundedString(value, field, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp.`);
  return timestamp;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`Unknown Office driver field: ${unknown}`);
}
