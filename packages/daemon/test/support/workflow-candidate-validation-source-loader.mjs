import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import "./workflow-git-results-source-loader.mjs";

const packages = new URL("../../../", import.meta.url);
const source = new URL("daemon/src/features/channels/workflow-candidate-validation.ts", packages).href;
const compiled = new URL("daemon/dist/features/channels/workflow-candidate-validation.js", packages).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@ling-stack/core" && context.parentURL === source) {
      return nextResolve(new URL("core/src/workflow-isolation.ts", packages).href, context);
    }
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const target = new URL(specifier, context.parentURL).href;
      if (target === compiled || target === source.replace(/\.ts$/u, ".js")) return nextResolve(source, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === source) return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform", sourceUrl: url }) };
    return nextLoad(url, context);
  },
});
