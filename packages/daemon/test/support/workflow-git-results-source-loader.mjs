import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Scoped P2 source verification. Never builds or overwrites the shared dist tree.
const packages = new URL("../../../", import.meta.url);
const isolation = new URL("core/src/workflow-isolation.ts", packages).href;
const candidate = new URL("daemon/src/features/channels/workflow-integration-candidate.ts", packages).href;
const coreFacade = new URL("workflow-git-results-core-facade.mjs", import.meta.url).href;
const sources = new Set([
  "core/src/workflow-isolation.ts",
  "daemon/src/features/channels/workflow-branch-result.ts",
  "daemon/src/features/channels/workflow-integration-candidate.ts",
  "daemon/src/features/workspaces/managed-worktrees.ts",
  "daemon/src/features/workspaces/workflow-git-repository.ts",
].map(path => new URL(path, packages).href));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@ling-stack/core" && context.parentURL === candidate) return { url: coreFacade, shortCircuit: true };
    if (!specifier.startsWith(".") && !specifier.startsWith("file:")) return nextResolve(specifier, context);
    const target = new URL(specifier, context.parentURL);
    if (!target.href.startsWith(packages.href)) return nextResolve(specifier, context);
    const source = new URL(target.href.replace(/\/dist\/(.+)\.js$/u, "/src/$1.ts").replace(/\.js$/u, ".ts"));
    if (sources.has(source.href) && existsSync(source)) return nextResolve(source.href, context);
    if (context.parentURL && sources.has(context.parentURL)) {
      const compiled = new URL(target.href.replace(/\/src\//u, "/dist/").replace(/\.ts$/u, ".js"));
      if (existsSync(compiled)) return nextResolve(compiled.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === coreFacade) return { format: "module", shortCircuit: true,
      source: `export { normalizeWorkflowIntegrationRoundInputs, workflowIntegrationRoundInputsDigest } from ${JSON.stringify(isolation)};` };
    if (sources.has(url)) return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }) };
    return nextLoad(url, context);
  },
});
