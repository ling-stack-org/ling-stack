import { builtinModules } from "node:module";
import { posix } from "node:path";
import { parse } from "acorn";
import { isChannelOperationRelativePathV1, isChannelCommandInputScopeV1, type ChannelCommandInputScopeV1,
  type ChannelOperationFileBindingV1, type UnifiedExecIsolationEvidence } from "@ling-stack/contracts";

type InputEvidence = UnifiedExecIsolationEvidence["inputs"][number];
export type CapturedCommandInput = InputEvidence & { readonly bytes: Buffer };
type SyntaxNode = { readonly type: string; readonly [key: string]: unknown };
const builtins = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/u, ""), `node:${name.replace(/^node:/u, "")}`]));
const moduleFile = (path: string) => /\.(?:js|mjs|cjs)$/u.test(path);
const inside = (root: string, path: string) => path.startsWith(root + "/");
const protectedPath = (path: string) => path.split("/").some(part => part.startsWith("."));
function requireInput(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

/** Pure analysis of captured bytes. Its results are dependency facts, never grants. */
function dependencies(bytes: Buffer): readonly string[] {
  requireInput(bytes.length <= 1024 * 1024, "restricted_command_dependency_source_budget_exceeded");
  const code = bytes.toString("utf8");
  requireInput(Buffer.from(code).equals(bytes), "restricted_command_dependency_source_invalid");
  let ast: SyntaxNode;
  try { ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true,
    allowHashBang: true }) as unknown as SyntaxNode; }
  catch { throw new Error("restricted_command_dependency_source_invalid"); }
  const stack: SyntaxNode[] = [ast], result = new Set<string>();
  let count = 0;
  const literal = (value: unknown) => {
    const node = value as SyntaxNode | undefined;
    requireInput(node?.type === "Literal" && typeof node.value === "string", "restricted_command_dependency_unsupported");
    result.add(node.value);
  };
  while (stack.length) {
    requireInput(++count <= 200000, "restricted_command_dependency_source_budget_exceeded");
    const node = stack.pop()!;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)
      && node.source) literal(node.source);
    if (node.type === "CallExpression" && (node.callee as SyntaxNode | undefined)?.type === "Identifier"
      && (node.callee as SyntaxNode).name === "require") {
      const args = node.arguments as readonly unknown[];
      requireInput(args.length === 1, "restricted_command_dependency_unsupported"); literal(args[0]);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") stack.push(child as SyntaxNode);
      }
    }
  }
  return [...result];
}

/** Captures only explicit inputs or local module edges intersected with an accepted
 * Host scope. The callback must enforce native path/identity/owner checks for every
 * byte. No filesystem walk, source evaluation, install or origin fallback exists.
 */
export async function captureNodeCommandInputs(input: {
  readonly inputRefs: readonly ChannelOperationFileBindingV1[];
  readonly commandInputScope?: ChannelCommandInputScopeV1;
  readonly analyzeModules?: boolean;
  /** Presence only, under the same owner guard; never returns source bytes. */
  readonly hasOptionalInput: (path: string) => boolean;
  readonly capture: (path: string, maxBytes: number) => Promise<{
    readonly bytes: Buffer; readonly sha256: string;
  }>;
  /** Host may lower limits (including in tests), never raise protocol ceilings. */
  readonly maxFiles?: number;
}): Promise<readonly CapturedCommandInput[]> {
  requireInput(input.commandInputScope === undefined || isChannelCommandInputScopeV1(input.commandInputScope), "restricted_command_dependency_scope_invalid");
  requireInput(input.commandInputScope === undefined || input.analyzeModules !== false, "restricted_command_dependency_scope_invalid");
  const scope = input.commandInputScope && structuredClone(input.commandInputScope), refs = structuredClone(input.inputRefs);
  const maxFiles = Math.min(input.maxFiles ?? 256, 256);
  requireInput(Number.isSafeInteger(maxFiles) && maxFiles > 0 && refs.length <= maxFiles
    && new Set(refs.map(ref => ref.path)).size === refs.length, "restricted_command_input_budget_exceeded");
  const files = new Map<string, CapturedCommandInput>(), metadataChecked = new Set<string>();
  let totalBytes = 0;
  const capture = async (path: string, sourceItemIds: readonly string[], derivation?: InputEvidence["derivation"], optional = false) => {
    if (files.has(path)) return;
    requireInput(isChannelOperationRelativePathV1(path) && path.length <= 4096 && !path.split("/").includes(".ling"), "restricted_command_protected_input");
    if (optional && !input.hasOptionalInput(path)) return;
    requireInput(files.size < maxFiles && totalBytes < 64 * 1024 * 1024, "restricted_command_input_budget_exceeded");
    const captured = await input.capture(path, Math.min(16 * 1024 * 1024, 64 * 1024 * 1024 - totalBytes));
    requireInput(captured.bytes.length <= 16 * 1024 * 1024 && /^[a-f0-9]{64}$/u.test(captured.sha256), "restricted_command_input_invalid");
    totalBytes += captured.bytes.length;
    requireInput(totalBytes <= 64 * 1024 * 1024, "restricted_command_input_budget_exceeded");
    files.set(path, { ...captured, path, sizeBytes: captured.bytes.length, sourceItemIds: [...new Set(sourceItemIds)],
      ...(derivation ? { derivation } : {}) });
  };
  for (const ref of refs) await capture(ref.path, ref.sourceRefs.map(source => source.itemId));
  // Map iteration visits newly captured dependencies once, terminating on cycles.
  for (const file of files.values()) {
    if (input.analyzeModules === false || !moduleFile(file.path)) continue;
    const scopeForFile = scope && inside(scope.projectRoot, file.path) ? scope : undefined;
    if (scopeForFile) {
      let directory = posix.dirname(file.path);
      let packageBoundary = false;
      while (directory === scopeForFile.projectRoot || inside(scopeForFile.projectRoot, directory)) {
        const metadataPath = `${directory}/package.json`;
        if (!metadataChecked.has(metadataPath)) {
          requireInput(metadataChecked.size < 2048, "restricted_command_dependency_probe_budget_exceeded");
          metadataChecked.add(metadataPath);
          requireInput(!protectedPath(metadataPath), "restricted_command_dependency_outside_scope");
          await capture(metadataPath, scopeForFile.sourceRefs.map(source => source.itemId), {
            kind: "node_package_metadata_v1", parentPath: file.path, parentSha256: file.sha256, projectRoot: scopeForFile.projectRoot }, true);
        }
        const metadata = files.get(metadataPath);
        if (metadata) {
          try { JSON.parse(metadata.bytes.toString("utf8")); }
          catch { throw new Error("restricted_command_dependency_package_invalid"); }
          packageBoundary = true; break;
        }
        if (directory === scopeForFile.projectRoot) break;
        directory = posix.dirname(directory);
      }
      // .js interpretation can inherit an unauthorized ancestor package. Refuse
      // an open boundary instead of changing ESM/CJS behavior in the copy.
      requireInput(!file.path.endsWith(".js") || packageBoundary,
        "restricted_command_dependency_package_boundary_required");
    }
    for (const specifier of dependencies(file.bytes)) {
      if (builtins.has(specifier)) continue;
      requireInput(specifier.startsWith("./") || specifier.startsWith("../"), "restricted_command_dependency_unsupported");
      requireInput(/\.(?:js|mjs|cjs|json)$/u.test(specifier) && !/[\\%?#\u0000-\u001f]/u.test(specifier), "restricted_command_dependency_unsupported");
      const path = posix.normalize(posix.join(posix.dirname(file.path), specifier));
      requireInput(isChannelOperationRelativePathV1(path) && !protectedPath(path), "restricted_command_dependency_outside_scope");
      if (files.has(path)) continue; // Already explicitly authorized or safely derived.
      requireInput(scopeForFile, "restricted_command_dependency_scope_required");
      requireInput(inside(scopeForFile.projectRoot, path), "restricted_command_dependency_outside_scope");
      await capture(path, scopeForFile.sourceRefs.map(source => source.itemId), {
        kind: "node_module_dependency_v1", parentPath: file.path, parentSha256: file.sha256, projectRoot: scopeForFile.projectRoot });
    }
  }
  return [...files.values()];
}
