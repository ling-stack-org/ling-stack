import ts from "typescript-language-service";
import { dirname, relative, resolve, sep } from "node:path";
import type { CodeSnapshot } from "./snapshot.js";

const embeddedCodeIntelligenceLibraries: string = "NO_PACKAGED_CODE_INTELLIGENCE_LIBRARIES";
export interface CodeQuery {
  operation: "definition" | "references" | "hover" | "symbols" | "diagnostics" | "repo_map";
  path: string; scope?: string; line?: number; column?: number; query?: string; limit?: number;
}

/** The compiler sees captured sources and its own standard library, never project I/O. */
export function queryCodeSnapshot(snapshot: CodeSnapshot, query: CodeQuery): { items: unknown[]; truncated: boolean } {
  const { files, root } = snapshot;
  const paths = Object.keys(files);
  const libraries: Record<string, string> | undefined = embeddedCodeIntelligenceLibraries === "NO_PACKAGED_CODE_INTELLIGENCE_LIBRARIES"
    ? undefined : JSON.parse(embeddedCodeIntelligenceLibraries);
  const libDirectory = libraries ? "/ling-typescript-lib" : dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
  const isLibrary = (path: string) => dirname(path) === libDirectory && /^lib\.[a-z0-9.]+\.d\.ts$/.test(path.slice(libDirectory.length + 1));
  const read = (path: string) => Object.hasOwn(files, path) ? files[path] : isLibrary(path)
    ? libraries ? libraries[path.slice(libDirectory.length + 1)] : ts.sys.readFile(path) : undefined;
  const directories = new Set(paths.flatMap(path => {
    const result = []; let cursor = dirname(path);
    while (cursor === root || cursor.startsWith(root + sep)) { result.push(cursor); if (cursor === root) break; cursor = dirname(cursor); }
    return result;
  }));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => paths, getScriptVersion: () => "1",
    getScriptSnapshot: path => { const text = read(path); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve, allowImportingTsExtensions: true }),
    getDefaultLibFileName: options => libraries ? `${libDirectory}/lib.es2022.full.d.ts` : ts.getDefaultLibFilePath(options),
    fileExists: path => Object.hasOwn(files, path) || isLibrary(path) && (libraries ? Object.hasOwn(libraries, path.slice(libDirectory.length + 1)) : ts.sys.fileExists(path)),
    readFile: read, directoryExists: path => directories.has(path) || path === libDirectory,
    readDirectory: () => [], getDirectories: path => [...directories].filter(child => dirname(child) === path),
    useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const service = ts.createLanguageService(host);
  const limit = query.limit ?? 50;
  const file = resolve(root, query.path);
  const source = () => {
    const result = service.getProgram()?.getSourceFile(file);
    if (!result || !Object.hasOwn(files, file)) throw new Error("code_intelligence_file_not_indexed");
    return result;
  };
  const position = () => {
    const document = source();
    const lines = document.getLineStarts();
    const line = query.line! - 1, column = query.column! - 1;
    if (!Number.isSafeInteger(line) || line < 0 || line >= lines.length || !Number.isSafeInteger(column) || column < 0) {
      throw new Error("code_intelligence_position_invalid");
    }
    const end = line + 1 < lines.length ? lines[line + 1] : document.text.length;
    const content = document.text.slice(lines[line], end).replace(/\r?\n$/, "");
    if (column > content.length) throw new Error("code_intelligence_position_invalid");
    return lines[line] + column;
  };
  const location = (path: string, span: ts.TextSpan) => {
    if (!Object.hasOwn(files, path)) return undefined;
    const document = service.getProgram()?.getSourceFile(path);
    if (!document) return undefined;
    const start = document.getLineAndCharacterOfPosition(span.start);
    const end = document.getLineAndCharacterOfPosition(span.start + span.length);
    return { path: relative(root, path).split(sep).join("/"), line: start.line + 1, column: start.character + 1,
      endLine: end.line + 1, endColumn: end.character + 1 };
  };
  try {
    let items: unknown[] = [];
    if (query.operation === "definition") {
      items = (service.getDefinitionAtPosition(file, position()) ?? []).flatMap(item => {
        const at = location(item.fileName, item.textSpan); return at ? [{ ...at, name: item.name, kind: item.kind }] : [];
      });
    } else if (query.operation === "references") {
      items = (service.getReferencesAtPosition(file, position()) ?? []).flatMap(item => {
        const at = location(item.fileName, item.textSpan); return at ? [{ ...at, isWriteAccess: item.isWriteAccess }] : [];
      });
    } else if (query.operation === "hover") {
      const item = service.getQuickInfoAtPosition(file, position());
      if (item) items = [{ ...location(file, item.textSpan), kind: item.kind,
        display: ts.displayPartsToString(item.displayParts), documentation: ts.displayPartsToString(item.documentation) }];
    } else if (query.operation === "diagnostics") {
      source();
      items = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(item => ({
        ...(item.file && item.start !== undefined ? location(item.file.fileName, { start: item.start, length: item.length ?? 0 }) : {}),
        code: item.code, category: ts.DiagnosticCategory[item.category], message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
      }));
    } else {
      const selected = query.operation === "symbols" ? [source().fileName] : paths.sort();
      const needle = query.query?.toLowerCase();
      const collect = (path: string, nodes: ts.NavigationTree[], container?: string) => {
        for (const node of nodes) {
          if (node.kind !== "script" && node.spans[0] && (!needle || node.text.toLowerCase().includes(needle))) {
            items.push({ ...location(path, node.nameSpan ?? node.spans[0]), name: node.text, kind: node.kind, ...(container ? { container } : {}) });
          }
          if (node.childItems) collect(path, node.childItems, node.kind === "script" ? undefined : node.text);
        }
      };
      for (const path of selected) {
        if (query.operation === "repo_map") {
          const imports = ts.preProcessFile(files[path], true, true).importedFiles.map(item => item.fileName);
          if (!needle || relative(root, path).toLowerCase().includes(needle)) {
            items.push({ path: relative(root, path).split(sep).join("/"), kind: "file", imports: imports.slice(0, 30) });
          }
        }
        collect(path, [service.getNavigationTree(path)]);
        if (items.length > limit * 2) break;
      }
    }
    return { items: items.slice(0, limit), truncated: items.length > limit };
  } finally { service.dispose(); }
}
