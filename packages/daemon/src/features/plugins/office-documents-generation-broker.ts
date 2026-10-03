import { randomUUID } from "node:crypto";
import {
  OFFICE_DOCUMENTS_MCP_SERVER_ID,
  OFFICE_DRIVER_PROTOCOL,
  isOfficeDocumentToolName,
  isOfficeLiveToolName,
  officeDocumentToolNames,
  officeLiveToolNames,
  officeMethodForTool,
  type OfficeDriverCapability,
  type OfficeDriverPlatform,
  type OfficeLiveToolName,
} from "@ling-stack/contracts";
import type { McpRuntimeStatusSnapshot, McpServer, ReplaceMcpServerToolInput } from "@ling-stack/core";
import type { PiRunnerMcpToolCallResult } from "@ling-stack/runner-pi";
import type { McpBroker, McpBrokerOptions } from "../../context.js";
import { OfficeArtifactService } from "../office-documents/artifacts.js";
import type { OfficeDriverController } from "../office-documents/driver-controller.js";
import { createMcpAuthStatus, createMcpStatusSnapshot } from "../mcp/status.js";
import { createHostMcpGenerationFacade } from "../mcp/broker.js";

const FILE_TOOLS: readonly ReplaceMcpServerToolInput[] = [
  tool("office_inspect_document", "Inspect Office document", "Read bounded text and structural metadata from a local XLSX, DOCX, or PPTX file.", schema(["path"], { path: stringSchema(4096) }), "read"),
  tool("office_validate_document", "Validate Office document", "Validate a local XLSX, DOCX, or PPTX package and report bounded warnings.", schema(["path"], { path: stringSchema(4096) }), "read"),
  tool("office_create_workbook", "Create workbook", "Create a standards-based XLSX workbook in the current workspace.", schema(["path", "sheets"], {
    path: stringSchema(4096), overwrite: { type: "boolean" }, sheets: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["name", "rows"], properties: { name: stringSchema(31), rows: matrixSchema(), columnWidths: { type: "array", maxItems: 256, items: { type: "number", minimum: 4, maximum: 80 } }, freezeHeader: { type: "boolean" }, headerStyle: { type: "boolean" } }, additionalProperties: false } },
  }), "write"),
  tool("office_edit_workbook", "Edit workbook", "Edit typed values, formulas, and basic cell formatting in an existing XLSX workbook.", schema(["path", "edits"], {
    path: stringSchema(4096), edits: { type: "array", minItems: 1, maxItems: 2000, items: { type: "object", required: ["sheet", "cell"], properties: { sheet: stringSchema(31), cell: stringSchema(32), value: {}, formula: stringSchema(8192), bold: { type: "boolean" }, numberFormat: stringSchema(128) }, additionalProperties: false } },
  }), "write"),
  tool("office_create_document", "Create Word document", "Create a standards-based DOCX document in the current workspace.", schema(["path", "blocks"], {
    path: stringSchema(4096), overwrite: { type: "boolean" }, blocks: { type: "array", minItems: 1, maxItems: 2000, items: { anyOf: [
      { type: "object", required: ["type", "text"], properties: { type: { const: "paragraph" }, text: stringSchema(50000), heading: { type: "integer", minimum: 1, maximum: 3 }, bold: { type: "boolean" } }, additionalProperties: false },
      { type: "object", required: ["type", "rows"], properties: { type: { const: "table" }, rows: matrixSchema() }, additionalProperties: false },
    ] } },
  }), "write"),
  tool("office_edit_document", "Edit Word document", "Replace exact text runs or append plain paragraphs while preserving the existing DOCX package.", {
    ...schema(["path"], {
      path: stringSchema(4096),
      replacements: replacementsSchema(true),
      appendParagraphs: { type: "array", minItems: 1, maxItems: 200, items: stringSchema(50_000) },
    }),
    anyOf: [{ required: ["replacements"] }, { required: ["appendParagraphs"] }],
  }, "write"),
  tool("office_create_presentation", "Create presentation", "Create a standards-based PPTX presentation in the current workspace.", schema(["path", "slides"], {
    path: stringSchema(4096), overwrite: { type: "boolean" }, title: stringSchema(512), subject: stringSchema(512), slides: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", required: ["title"], properties: { title: stringSchema(512), bullets: { type: "array", maxItems: 30, items: stringSchema(1000) } }, additionalProperties: false } },
  }), "write"),
  tool("office_edit_presentation", "Edit presentation", "Replace exact text runs on explicit PPTX slides while preserving the existing package.", schema(["path", "replacements"], {
    path: stringSchema(4096), replacements: replacementsSchema(false),
  }), "write"),
  tool("office_render_document", "Render Office document preview", "Render a bounded escaped HTML outline from a local XLSX, DOCX, or PPTX file.", schema(["path"], {
    path: stringSchema(4096),
  }), "read"),
];

const LIVE_TOOL_DEFINITIONS = new Map<OfficeLiveToolName, { readonly capability: OfficeDriverCapability; readonly definition: ReplaceMcpServerToolInput }>([
  ["office_list_sessions", { capability: "excel:sessions", definition: liveTool("office_list_sessions", "List Excel sessions", "List bounded metadata for open Microsoft Excel workbooks.", schema([], {}), "read") }],
  ["office_read_ranges", { capability: "excel:read", definition: liveTool("office_read_ranges", "Read Excel ranges", "Read values and formulas from ranges in one explicit live Excel session.", sessionSchema(["ranges"], { ranges: { type: "array", minItems: 1, maxItems: 50, items: stringSchema(64) } }), "read") }],
  ["office_search_workbook", { capability: "excel:search", definition: liveTool("office_search_workbook", "Search Excel workbook", "Search values and formulas in one explicit live Excel session.", sessionSchema(["query"], { query: stringSchema(512), maxResults: { type: "integer", minimum: 1, maximum: 200 } }), "read") }],
  ["office_write_range", { capability: "excel:write", definition: liveTool("office_write_range", "Write Excel range", "Write a bounded value or formula matrix to an explicit range in a live Excel session.", {
    ...sessionSchema(["range"], { range: stringSchema(64), values: matrixSchema(), formulas: matrixSchema() }),
    anyOf: [{ required: ["values"] }, { required: ["formulas"] }],
  }, "write") }],
  ["office_update_sheet", { capability: "excel:sheets", definition: liveTool("office_update_sheet", "Update Excel sheet", "Create, rename, or delete a worksheet in a live Excel session.", sessionSchema(["action"], { action: { enum: ["create", "rename", "delete"] }, sheet: stringSchema(31), name: stringSchema(31) }), "write") }],
  ["office_format_range", { capability: "excel:format-basic", definition: liveTool("office_format_range", "Format Excel range", "Apply bounded basic formatting to an explicit live Excel range.", sessionSchema(["range", "format"], { range: stringSchema(64), format: { type: "object", minProperties: 1, properties: { bold: { type: "boolean" }, italic: { type: "boolean" }, numberFormat: stringSchema(128), fillColor: stringSchema(8), fontColor: stringSchema(8) }, additionalProperties: false } }), "write") }],
  ["office_save_workbook", { capability: "excel:save", definition: liveTool("office_save_workbook", "Save Excel workbook", "Save one explicit live Excel workbook after its recovery point is established.", sessionSchema([], {}), "write") }],
  ["office_save_workbook_as", { capability: "excel:save-as", definition: liveTool("office_save_workbook_as", "Save Excel workbook as", "Save one live Excel workbook to an explicit workspace path.", sessionSchema(["path"], { path: stringSchema(4096), overwrite: { type: "boolean" } }), "write") }],
  ["office_create_table", { capability: "excel:tables", definition: liveTool("office_create_table", "Create Excel table", "Create a native table from an explicit live Excel range on Windows.", sessionSchema(["range", "name"], { range: stringSchema(64), name: stringSchema(128), hasHeaders: { type: "boolean" } }), "write") }],
  ["office_create_chart", { capability: "excel:charts", definition: liveTool("office_create_chart", "Create Excel chart", "Create a native chart from an explicit live Excel range on Windows.", sessionSchema(["range", "chartType"], { range: stringSchema(64), chartType: { enum: ["column", "bar", "line", "pie", "scatter"] }, title: stringSchema(512) }), "write") }],
  ["office_apply_filter", { capability: "excel:filters", definition: liveTool("office_apply_filter", "Filter Excel range", "Apply a bounded native filter to a live Excel range on Windows.", sessionSchema(["range", "field", "criteria"], { range: stringSchema(64), field: { type: "integer", minimum: 1, maximum: 256 }, criteria: stringSchema(512) }), "write") }],
  ["office_resize_range", { capability: "excel:resize", definition: liveTool("office_resize_range", "Resize Excel range", "Set bounded row heights or column widths in a live Excel range on Windows.", {
    ...sessionSchema(["range"], { range: stringSchema(64), columnWidth: { type: "number", minimum: 4, maximum: 80 }, rowHeight: { type: "number", minimum: 8, maximum: 200 } }),
    anyOf: [{ required: ["columnWidth"] }, { required: ["rowHeight"] }],
  }, "write") }],
]);

const MACOS_FORMAT_RANGE_DEFINITION = liveTool(
  "office_format_range",
  "Format Excel range",
  "Apply formatting supported by the macOS native Excel adapter to an explicit live range.",
  sessionSchema(["range", "format"], {
    range: stringSchema(64),
    format: {
      type: "object",
      minProperties: 1,
      properties: {
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        numberFormat: stringSchema(128),
      },
      additionalProperties: false,
    },
  }),
  "write",
);

export const officeDocumentTools = FILE_TOOLS;
export const officeAllTools: readonly ReplaceMcpServerToolInput[] = [
  ...FILE_TOOLS,
  ...officeLiveToolNames.flatMap((name) => {
    const entry = LIVE_TOOL_DEFINITIONS.get(name);
    return entry ? [entry.definition] : [];
  }),
];

export function officeToolsForCapabilities(
  capabilities: readonly OfficeDriverCapability[],
  platform?: OfficeDriverPlatform,
): readonly ReplaceMcpServerToolInput[] {
  const supported = new Set(capabilities);
  return [
    ...FILE_TOOLS,
    ...officeLiveToolNames.flatMap((name) => {
      const entry = LIVE_TOOL_DEFINITIONS.get(name);
      return entry && supported.has(entry.capability) ? [liveDefinitionForPlatform(name, entry.definition, platform)] : [];
    }),
  ];
}

export function createOfficeDocumentsGenerationBroker(input: {
  readonly baseBroker: McpBroker;
  readonly workspaceCwd: string;
  readonly controller: OfficeDriverController;
  readonly artifacts?: OfficeArtifactService;
}): McpBroker {
  const artifacts = input.artifacts ?? new OfficeArtifactService();
  const owned = (server: McpServer): boolean => server.id === OFFICE_DOCUMENTS_MCP_SERVER_ID;
  const facade: McpBroker = {
    cuaDriverRuntimeAuthority: input.baseBroker.cuaDriverRuntimeAuthority,
    async checkServer(server, options) {
      if (!owned(server)) return input.baseBroker.checkServer(server, options);
      return { statusSnapshot: officeStatus(server, options, input.controller) };
    },
    async listTools(server, options) {
      if (!owned(server)) return input.baseBroker.listTools(server, options);
      const statusSnapshot = officeStatus(server, options, input.controller);
      const live = liveToolsFor(input.controller);
      return { statusSnapshot, tools: server.enabled ? [...FILE_TOOLS, ...live] : [] };
    },
    async callTool(server, options, toolName, toolInput) {
      if (!owned(server)) return input.baseBroker.callTool(server, options, toolName, toolInput);
      if (!server.enabled || options.workspaceCwd !== input.workspaceCwd) throw new Error("office_documents_tool_unavailable");
      options.signal?.throwIfAborted();
      let result: unknown;
      if (isOfficeDocumentToolName(toolName)) {
        if (toolName === "office_inspect_document") result = await artifacts.inspect(input.workspaceCwd, toolInput, options.signal);
        else if (toolName === "office_validate_document") result = await artifacts.validate(input.workspaceCwd, toolInput, options.signal);
        else if (toolName === "office_create_workbook") result = await artifacts.createWorkbook(input.workspaceCwd, toolInput);
        else if (toolName === "office_edit_workbook") result = await artifacts.editWorkbook(input.workspaceCwd, toolInput);
        else if (toolName === "office_create_document") result = await artifacts.createDocument(input.workspaceCwd, toolInput);
        else if (toolName === "office_edit_document") result = await artifacts.editDocument(input.workspaceCwd, toolInput, options.signal);
        else if (toolName === "office_create_presentation") result = await artifacts.createPresentation(input.workspaceCwd, toolInput);
        else if (toolName === "office_edit_presentation") result = await artifacts.editPresentation(input.workspaceCwd, toolInput, options.signal);
        else result = await artifacts.renderDocument(input.workspaceCwd, toolInput, options.signal);
      } else if (isOfficeLiveToolName(toolName)) {
        assertLiveToolAvailable(toolName, input.controller);
        const liveInput = toolName === "office_save_workbook_as"
          ? await artifacts.prepareWorkbookSaveAs(input.workspaceCwd, toolInput)
          : toolInput;
        result = await input.controller.execute({
          method: officeMethodForTool(toolName),
          params: liveInput,
          idempotencyKey: `${options.runId ?? randomUUID()}:${options.toolCallId ?? randomUUID()}`,
          signal: options.signal,
        });
      } else {
        throw new Error("office_documents_tool_unavailable");
      }
      options.signal?.throwIfAborted();
      options.assertResultCurrent?.();
      return toToolResult(toolName, result);
    },
  };
  return createHostMcpGenerationFacade({ baseBroker: input.baseBroker, route: { kind: "office" }, facade });
}

function liveToolsFor(controller: OfficeDriverController): readonly ReplaceMcpServerToolInput[] {
  const snapshot = controller.snapshot();
  if (!snapshot.connected || !snapshot.availability || !["ready", "limited"].includes(snapshot.availability.state)) return [];
  const capabilities = new Set(snapshot.availability.capabilities);
  return officeLiveToolNames.flatMap((name) => {
    const entry = LIVE_TOOL_DEFINITIONS.get(name);
    return entry && capabilities.has(entry.capability)
      ? [liveDefinitionForPlatform(name, entry.definition, snapshot.availability?.platform)]
      : [];
  });
}

function liveDefinitionForPlatform(
  toolName: OfficeLiveToolName,
  fallback: ReplaceMcpServerToolInput,
  platform?: OfficeDriverPlatform,
): ReplaceMcpServerToolInput {
  return platform === "darwin" && toolName === "office_format_range"
    ? MACOS_FORMAT_RANGE_DEFINITION
    : fallback;
}

function assertLiveToolAvailable(toolName: OfficeLiveToolName, controller: OfficeDriverController): void {
  const entry = LIVE_TOOL_DEFINITIONS.get(toolName);
  const availability = controller.snapshot().availability;
  if (!entry || !availability?.capabilities.includes(entry.capability)) throw new Error("office_live_capability_unavailable");
}

function officeStatus(server: McpServer, options: McpBrokerOptions, controller: OfficeDriverController): McpRuntimeStatusSnapshot {
  const now = options.now?.() ?? new Date().toISOString();
  const liveTools = liveToolsFor(controller);
  return createMcpStatusSnapshot({
    server,
    now,
    status: server.enabled ? "ready" : "disabled",
    authStatus: createMcpAuthStatus([]),
    protocolVersion: OFFICE_DRIVER_PROTOCOL,
    serverInfo: { name: "ling-office-documents", version: "0.1.0" },
    toolCount: server.enabled ? officeDocumentToolNames.length + liveTools.length : 0,
    message: server.enabled
      ? liveTools.length > 0 ? "Office file tools and live Excel tools are ready." : "Office file tools are ready. Live Excel requires Ling Desktop."
      : "Office Documents plugin is disabled.",
  });
}

function tool(rawName: string, displayName: string, description: string, inputSchema: unknown, sideEffectLevel: ReplaceMcpServerToolInput["sideEffectLevel"]): ReplaceMcpServerToolInput {
  return { rawName, displayName, description, inputSchema, callableNamespace: "office", callableName: rawName, sideEffectLevel, defaultApproval: sideEffectLevel === "read" ? "allow" : "ask" };
}

function liveTool(rawName: string, displayName: string, description: string, inputSchema: unknown, sideEffectLevel: ReplaceMcpServerToolInput["sideEffectLevel"]): ReplaceMcpServerToolInput {
  return tool(rawName, displayName, description, inputSchema, sideEffectLevel);
}

function schema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", required, properties, additionalProperties: false };
}

function sessionSchema(required: readonly string[], properties: Record<string, unknown>): Record<string, unknown> {
  return schema(["sessionId", ...required], { sessionId: stringSchema(256), ...properties });
}

function stringSchema(maxLength: number): unknown {
  return { type: "string", minLength: 1, maxLength };
}

function matrixSchema(): unknown {
  return { type: "array", maxItems: 10_000, items: { type: "array", maxItems: 256, items: {} } };
}

function replacementsSchema(allowAllSlides: boolean): unknown {
  return {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: {
      type: "object",
      required: ["search", "replace"],
      properties: {
        ...(!allowAllSlides ? { slide: { type: "integer", minimum: 1, maximum: 200 } } : {}),
        search: stringSchema(1_000),
        replace: { type: "string", maxLength: 10_000 },
        all: { type: "boolean" },
      },
      additionalProperties: false,
    },
  };
}

function toToolResult(toolName: string, result: unknown): PiRunnerMcpToolCallResult {
  const text = JSON.stringify({ toolName, data: result });
  if (text.length > 512 * 1024) throw new Error("office_documents_result_too_large");
  return { content: [{ type: "text", text }], details: result };
}
