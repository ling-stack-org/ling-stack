import { createHash } from "node:crypto";
import type { WebContents } from "electron";
import { browserRecord, browserString } from "@ling-stack/contracts";
import { validateWebToolArguments } from "./webmcp-schema.js";

interface WebTool { readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }
function webMcpProgram(request: { readonly action: "list" | "call" | "cancel"; readonly name?: string; readonly args?: object; readonly revision?: string; readonly chromiumMajor: number }): Promise<string> | string {
  type Tool = { name: string; description?: string; inputSchema?: object | string };
  type Context = { getTools(): Promise<Tool[]>; executeTool(tool: Tool, args: object | string, options: { signal: AbortSignal }): Promise<unknown>; addEventListener(name: string, callback: () => void): void };
  const root = globalThis as typeof globalThis & { __lingWebMcp?: { context: Context; revision: string; controller?: AbortController } };
  if (request.action === "cancel") { root.__lingWebMcp?.controller?.abort(); return "{}"; }
  const context = (document as Document & { modelContext?: Context }).modelContext;
  if (!context || typeof context.getTools !== "function" || typeof context.executeTool !== "function") return JSON.stringify({ available: false, reason: "runtime_api_unavailable", tools: [] });
  if (!root.__lingWebMcp || root.__lingWebMcp.context !== context) {
    const state = { context, revision: crypto.randomUUID(), controller: undefined as AbortController | undefined }; root.__lingWebMcp = state;
    context.addEventListener("toolchange", () => { state.revision = crypto.randomUUID(); state.controller?.abort(); });
  }
  const state = root.__lingWebMcp;
  return (async () => {
    const tools = await context.getTools();
    if (!Array.isArray(tools) || tools.length > 32) throw new Error("browser_webmcp_tool_budget_exceeded");
    if (request.action === "list") {
      const data = tools.map(tool => ({ name: tool.name, description: tool.description ?? "", inputSchema: typeof tool.inputSchema === "string" ? JSON.parse(tool.inputSchema) : tool.inputSchema ?? {} }));
      const encoded = JSON.stringify({ available: true, revision: state.revision, tools: data }); if (encoded.length > 65_536) throw new Error("browser_webmcp_schema_too_large"); return encoded;
    }
    if (request.revision !== state.revision) throw new Error("browser_webmcp_tools_stale");
    const tool = tools.find(tool => tool.name === request.name); if (!tool) throw new Error("browser_webmcp_tool_missing");
    const controller = new AbortController(); state.controller = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await context.executeTool(tool, request.chromiumMajor >= 155 ? request.args ?? {} : JSON.stringify(request.args ?? {}), { signal: controller.signal });
      if (controller.signal.aborted || request.revision !== state.revision) throw new Error("browser_webmcp_execution_stale");
      const encoded = JSON.stringify({ result }); if (encoded.length > 65_536) throw new Error("browser_webmcp_result_too_large"); return encoded;
    } finally { clearTimeout(timer); if (state.controller === controller) state.controller = undefined; }
  })();
}
export function webMcpScript(request: Omit<Parameters<typeof webMcpProgram>[0], "chromiumMajor">): string { return `(${webMcpProgram.toString()})(${JSON.stringify({ ...request, chromiumMajor: Number(process.versions.chrome?.split(".")[0] ?? 0) })})`; }
export class BrowserWebMcp {
  private snapshot?: { revision: string; nativeRevision: string; tools: WebTool[]; fingerprint: string };
  constructor(private readonly contents: WebContents) {}
  reset(): void { this.snapshot = undefined; if (!this.contents.isDestroyed()) void this.contents.executeJavaScript(webMcpScript({ action: "cancel" })).catch(() => undefined); }
  async list(): Promise<unknown> {
    const result = await this.discover(); if (!result.available) { this.snapshot = undefined; return { available: false, reason: "runtime_api_unavailable", tools: [] }; }
    const fingerprint = createHash("sha256").update(JSON.stringify([result.nativeRevision, result.tools])).digest("hex");
    this.snapshot = { revision: fingerprint, fingerprint, nativeRevision: result.nativeRevision!, tools: result.tools };
    return { available: true, toolRevision: fingerprint, tools: result.tools };
  }
  async call(name: string, args: object, revision: string, signal: AbortSignal): Promise<unknown> {
    const captured = this.snapshot; if (!captured || captured.revision !== revision) throw new Error("browser_webmcp_tools_stale");
    const current = await this.discover();
    const fingerprint = createHash("sha256").update(JSON.stringify([current.nativeRevision, current.tools])).digest("hex");
    const tool = captured.tools.find(tool => tool.name === name);
    if (!current.available || fingerprint !== captured.fingerprint || !tool) throw new Error("browser_webmcp_tools_stale");
    await validateWebToolArguments(tool.inputSchema, args, signal);
    const cancel = (): void => this.reset(); signal.throwIfAborted(); signal.addEventListener("abort", cancel, { once: true });
    try { const value: unknown = JSON.parse(await this.contents.executeJavaScript(webMcpScript({ action: "call", name, args, revision: captured.nativeRevision })) as string); signal.throwIfAborted(); return value; }
    finally { signal.removeEventListener("abort", cancel); }
  }
  private async discover(): Promise<{ available: boolean; nativeRevision?: string; tools: WebTool[] }> {
    const result: unknown = JSON.parse(await this.contents.executeJavaScript(webMcpScript({ action: "list" })) as string);
    const record = browserRecord(result, ["available", "reason", "revision", "tools"]);
    if (record.available === false) return { available: false, tools: [] };
    if (record.available !== true || !Array.isArray(record.tools) || record.tools.length > 32) throw new Error("browser_webmcp_invalid");
    const names = new Set<string>();
    const tools = record.tools.map(value => {
      const tool = browserRecord(value, ["name", "description", "inputSchema"]), name = browserString(tool.name, 128);
      if (names.has(name) || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("browser_webmcp_invalid");
      names.add(name); return { name, description: browserString(tool.description, 2000, true), inputSchema: tool.inputSchema as Record<string, unknown> };
    });
    return { available: true, nativeRevision: browserString(record.revision, 128), tools };
  }
}
