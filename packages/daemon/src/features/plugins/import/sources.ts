import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export const pluginImportSources = [
  "codex-config-toml",
  "claude-user-json",
  "claude-plugin-mcp",
  "dsh-cordis-patch",
  "claude-commands",
] as const satisfies readonly PluginImportSource[];

export type PluginImportSource =
  | "codex-config-toml"
  | "claude-user-json"
  | "claude-plugin-mcp"
  | "dsh-cordis-patch"
  | "claude-commands";

const DSH_MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const MAX_PLUGIN_MCP_JSON_FILES = 200;
const MAX_PLUGIN_SCAN_DEPTH = 4;
const MAX_COMMAND_FILES = 200;

export interface RawStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface RawHttpTransport {
  readonly type: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface RawMcpImportCandidate {
  readonly kind: "mcp";
  readonly source: Exclude<PluginImportSource, "claude-commands">;
  readonly name: string;
  readonly displayName: string;
  readonly transport: RawStdioTransport | RawHttpTransport;
}

export interface RawCommandImportCandidate {
  readonly kind: "command";
  readonly source: "claude-commands";
  readonly name: string;
  readonly displayName: string;
  readonly content: string;
  readonly inlineExecutions: readonly string[];
}

export type RawImportCandidate = RawMcpImportCandidate | RawCommandImportCandidate;

export interface RawImportScan {
  readonly source: PluginImportSource;
  readonly sourceFound: boolean;
  readonly candidates: readonly RawImportCandidate[];
  readonly warnings: readonly string[];
}

export interface PluginImportScanOptions {
  readonly homeDir?: string;
}

export function scanPluginImportSource(source: PluginImportSource, options: PluginImportScanOptions = {}): RawImportScan {
  const home = options.homeDir ?? homedir();
  try {
    switch (source) {
      case "codex-config-toml":
        return scanCodexConfigToml(home);
      case "claude-user-json":
        return scanClaudeUserJson(home);
      case "claude-plugin-mcp":
        return scanClaudePluginMcpJson(home);
      case "dsh-cordis-patch":
        return scanDshCordisPatch(home);
      case "claude-commands":
        return scanClaudeCommands(home);
    }
  } catch (error) {
    return {
      source,
      sourceFound: true,
      candidates: [],
      warnings: [`${source} scan failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function scanCodexConfigToml(home: string): RawImportScan {
  const path = join(home, ".codex", "config.toml");
  const content = readTextIfExists(path);
  if (!content.ok) {
    return { source: "codex-config-toml", sourceFound: false, candidates: [], warnings: [] };
  }
  const candidates: RawMcpImportCandidate[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseToml(content.value);
  } catch (error) {
    return {
      source: "codex-config-toml",
      sourceFound: true,
      candidates: [],
      warnings: [`codex config.toml parse failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const servers = isRecord(parsed) && isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  for (const [name, rawServer] of Object.entries(servers)) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const url = readStringField(rawServer, "url");
    if (url) {
      const headers = readStringRecordField(rawServer, "http_headers") ?? readStringRecordField(rawServer, "headers") ?? {};
      candidates.push({
        kind: "mcp",
        source: "codex-config-toml",
        name,
        displayName: name,
        transport: { type: "http", url, headers },
      });
      continue;
    }
    const command = readStringField(rawServer, "command");
    if (!command) {
      warnings.push(`codex mcp_servers.${name} has neither url nor command; skipped`);
      continue;
    }
    candidates.push({
      kind: "mcp",
      source: "codex-config-toml",
      name,
      displayName: name,
      transport: {
        type: "stdio",
        command,
        args: readStringArrayField(rawServer, "args") ?? [],
        env: readStringRecordField(rawServer, "env") ?? {},
        cwd: readStringField(rawServer, "cwd"),
      },
    });
  }
  return { source: "codex-config-toml", sourceFound: true, candidates, warnings };
}

function scanClaudeUserJson(home: string): RawImportScan {
  const path = join(home, ".claude.json");
  const content = readTextIfExists(path);
  if (!content.ok) {
    return { source: "claude-user-json", sourceFound: false, candidates: [], warnings: [] };
  }
  const candidates: RawMcpImportCandidate[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.value);
  } catch (error) {
    return {
      source: "claude-user-json",
      sourceFound: true,
      candidates: [],
      warnings: [`claude.json parse failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!isRecord(parsed)) {
    return { source: "claude-user-json", sourceFound: true, candidates: [], warnings: ["claude.json top level is not an object; skipped"] };
  }
  collectClaudeMcpServers(parsed.mcp_servers ?? parsed.mcpServers, "", candidates, warnings);
  const projects = isRecord(parsed.projects) ? parsed.projects : {};
  for (const [projectPath, projectValue] of Object.entries(projects)) {
    if (!isRecord(projectValue)) {
      continue;
    }
    collectClaudeMcpServers(projectValue.mcp_servers ?? projectValue.mcpServers, projectPath, candidates, warnings);
  }
  return { source: "claude-user-json", sourceFound: true, candidates, warnings };
}

function collectClaudeMcpServers(
  rawServers: unknown,
  projectPath: string,
  candidates: RawMcpImportCandidate[],
  warnings: string[],
): void {
  if (!isRecord(rawServers)) {
    return;
  }
  for (const [name, rawServer] of Object.entries(rawServers)) {
    if (!isRecord(rawServer)) {
      continue;
    }
    const displayBase = projectPath ? `${name} (${projectPath})` : name;
    const url = readStringField(rawServer, "url");
    if (url) {
      candidates.push({
        kind: "mcp",
        source: "claude-user-json",
        name: projectPath ? `${projectPath}:${name}` : name,
        displayName: displayBase,
        transport: {
          type: "http",
          url,
          headers: readStringRecordField(rawServer, "headers") ?? {},
        },
      });
      continue;
    }
    const command = readStringField(rawServer, "command");
    if (!command) {
      warnings.push(`claude mcpServers.${displayBase} has neither url nor command; skipped`);
      continue;
    }
    candidates.push({
      kind: "mcp",
      source: "claude-user-json",
      name: projectPath ? `${projectPath}:${name}` : name,
      displayName: displayBase,
      transport: {
        type: "stdio",
        command,
        args: readStringArrayField(rawServer, "args") ?? [],
        env: readStringRecordField(rawServer, "env") ?? {},
        cwd: readStringField(rawServer, "cwd"),
      },
    });
  }
}

function scanClaudePluginMcpJson(home: string): RawImportScan {
  const root = join(home, ".claude", "plugins");
  const candidates: RawMcpImportCandidate[] = [];
  const warnings: string[] = [];
  let sourceFound = false;
  const manifestPaths: string[] = [];
  collectMcpJsonPaths(root, 0, manifestPaths);
  if (manifestPaths.length > 0) {
    sourceFound = true;
  }
  for (const manifestPath of manifestPaths.slice(0, MAX_PLUGIN_MCP_JSON_FILES)) {
    const content = readTextIfExists(manifestPath);
    if (!content.ok) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.value);
    } catch (error) {
      warnings.push(`${manifestPath} parse failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const pluginRoot = manifestPath.slice(0, manifestPath.length - "/.mcp.json".length);
    const rootSegments = pluginRoot.split("/").filter(Boolean);
    // Claude cache layout is cache/<marketplace>/<plugin>/<version>/.mcp.json; the version
    // directory is the immediate parent, so the plugin name is one segment above it.
    const pluginName = rootSegments.length >= 2 ? rootSegments[rootSegments.length - 2] : rootSegments[0] ?? pluginRoot;
    const servers = isRecord(parsed) ? parsed.mcpServers ?? parsed.mcp_servers : undefined;
    if (!isRecord(servers)) {
      continue;
    }
    collectClaudeMcpServers(servers, `plugin:${pluginName}`, candidates, warnings);
  }
  return { source: "claude-plugin-mcp", sourceFound, candidates, warnings };
}

function collectMcpJsonPaths(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_PLUGIN_SCAN_DEPTH || out.length >= MAX_PLUGIN_MCP_JSON_FILES) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isFile() && entry.name === ".mcp.json") {
      out.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      collectMcpJsonPaths(entryPath, depth + 1, out);
    }
  }
}

function scanDshCordisPatch(home: string): RawImportScan {
  const path = join(home, ".dsh", "cordis.patch.yml");
  const content = readTextIfExists(path);
  if (!content.ok) {
    return { source: "dsh-cordis-patch", sourceFound: false, candidates: [], warnings: [] };
  }
  const candidates: RawMcpImportCandidate[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content.value);
  } catch (error) {
    return {
      source: "dsh-cordis-patch",
      sourceFound: true,
      candidates: [],
      warnings: [`cordis.patch.yml parse failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const inserts = collectDshInsertEntries(parsed);
  if (inserts.length === 0) {
    warnings.push("cordis.patch.yml contains no insert entries for the dsh MCP client; nothing to import");
  }
  for (const entry of inserts) {
    if (!isRecord(entry)) {
      continue;
    }
    const packageName = readStringField(entry, "name");
    if (packageName !== DSH_MCP_CLIENT_PACKAGE) {
      continue;
    }
    const config = isRecord(entry.config) ? entry.config : undefined;
    if (!config) {
      warnings.push(`dsh insert ${readStringField(entry, "id") ?? "(unnamed)"} has no config object; skipped`);
      continue;
    }
    const serverName = readStringField(config, "serverName") ?? readStringField(entry, "id") ?? "dsh-mcp";
    const transportKind = readStringField(config, "transport") ?? "stdio";
    const url = readStringField(config, "url");
    if (transportKind !== "stdio" || url) {
      if (!url) {
        warnings.push(`dsh insert ${serverName} declares a remote transport without url; skipped`);
        continue;
      }
      candidates.push({
        kind: "mcp",
        source: "dsh-cordis-patch",
        name: serverName,
        displayName: serverName,
        transport: {
          type: "http",
          url,
          headers: readStringRecordField(config, "headers") ?? {},
        },
      });
      continue;
    }
    const command = readStringField(config, "command");
    if (!command) {
      warnings.push(`dsh insert ${serverName} has no command; skipped`);
      continue;
    }
    candidates.push({
      kind: "mcp",
      source: "dsh-cordis-patch",
      name: serverName,
      displayName: serverName,
      transport: {
        type: "stdio",
        command,
        args: readStringArrayField(config, "args") ?? [],
        env: readStringRecordField(config, "env") ?? {},
        cwd: readStringField(config, "cwd"),
      },
    });
  }
  return { source: "dsh-cordis-patch", sourceFound: true, candidates, warnings };
}

function collectDshInsertEntries(parsed: unknown): unknown[] {
  const entries: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (isRecord(value) && "insert" in value) {
      visit(value.insert);
      return;
    }
    if (isRecord(value)) {
      entries.push(value);
    }
  };
  visit(parsed);
  return entries;
}

function scanClaudeCommands(home: string): RawImportScan {
  const dir = join(home, ".claude", "commands");
  const candidates: RawCommandImportCandidate[] = [];
  const warnings: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { source: "claude-commands", sourceFound: false, candidates: [], warnings: [] };
  }
  for (const entry of entries.slice(0, MAX_COMMAND_FILES)) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const content = readTextIfExists(join(dir, entry.name));
    if (!content.ok) {
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    candidates.push({
      kind: "command",
      source: "claude-commands",
      name,
      displayName: name,
      content: content.value,
      inlineExecutions: extractInlineExecutions(content.value),
    });
  }
  return { source: "claude-commands", sourceFound: true, candidates, warnings };
}

const INLINE_EXECUTION_PATTERN = /!`([^`]+)`/g;

export function extractInlineExecutions(markdown: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(INLINE_EXECUTION_PATTERN)) {
    if (match[1]) {
      found.push(match[1]);
    }
  }
  return found;
}

export function rewriteCommandInlineExecutions(markdown: string): string {
  return markdown.replace(INLINE_EXECUTION_PATTERN, (_match, command: string) => {
    return `\`bash: ${command}\`（Ling 需调用 bash 工具执行该命令后再继续）`;
  });
}

function readTextIfExists(path: string): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  try {
    return { ok: true, value: readFileSync(path, "utf8") };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringRecordField(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      out[entryKey] = entryValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}
