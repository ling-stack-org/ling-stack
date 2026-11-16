import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Verify this bounded P1 patch without rebuilding or mixing the rest of source with dist.
const packages = new URL("../../../", import.meta.url);
const sources = new Set([
  "core/src/builtin-skill-packs.ts",
  "daemon/src/features/channels/orchestrator.ts",
  "daemon/src/features/channels/smart-scheduler.ts",
].map(path => new URL(path, packages).href));

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".") && !specifier.startsWith("file:")) return nextResolve(specifier, context);
    const target = new URL(specifier, context.parentURL);
    if (!target.href.startsWith(packages.href)) return nextResolve(specifier, context);
    const source = new URL(target.href.replace(/\/dist\/(.+)\.js$/u, "/src/$1.ts").replace(/\.js$/u, ".ts"));
    if (sources.has(source.href)) return nextResolve(source.href, context);
    if (context.parentURL && sources.has(context.parentURL)) {
      const compiled = new URL(target.href.replace(/\/src\//u, "/dist/").replace(/\.ts$/u, ".js"));
      if (existsSync(compiled)) return nextResolve(compiled.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (sources.has(url)) return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }) };
    return nextLoad(url, context);
  },
});
