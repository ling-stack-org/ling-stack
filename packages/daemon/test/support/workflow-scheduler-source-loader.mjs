import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// Run these focused tests against current workspace sources without writing dist.
const packages = new URL("../../../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let target;
    if (specifier.startsWith("@ling-stack/")) {
      const [name, ...subpath] = specifier.slice("@ling-stack/".length).split("/");
      target = new URL(`${name}/src/${subpath.join("/") || "index"}.ts`, packages);
    } else if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      target = new URL(specifier, context.parentURL);
      if (!target.href.startsWith(packages.href)) return nextResolve(specifier, context);
      target.pathname = target.pathname.replace(/\/dist\/(.+)\.js$/, "/src/$1.ts");
      if (target.pathname.includes("/src/")) target.pathname = target.pathname.replace(/\.js$/, ".ts");
    }
    return target && existsSync(target) ? nextResolve(target.href, context) : nextResolve(specifier, context);
  },
});
