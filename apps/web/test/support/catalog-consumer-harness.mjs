import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatCatalogMessage, loadCatalog } from "@ling-stack/localization";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

export { React, renderToStaticMarkup };
const desktopRequire = createRequire(new URL("../../../desktop/package.json", import.meta.url));
const { build } = desktopRequire("esbuild");
const sourceRoot = new URL("../../src/", import.meta.url);
const english = (await loadCatalog("en-US")).messages;

/** Compile actual source bytes. Only context/IO ports and explicit test exports are replaced. */
export async function catalogConsumerHarness(t, { exports, expose = {}, transforms = {}, ports = {} }) {
  const directory = await mkdtemp(fileURLToPath(new URL("../../.catalog-consumer-", import.meta.url)));
  const key = `catalog-consumer:${directory}`;
  const state = { locale: "en-US", messages: english, captures: {}, ports, calls: [] };
  state.t = (message, values) => {
    const text = formatCatalogMessage(state.messages, english, message, values);
    state.calls.push({ key: message, values, text });
    return text;
  };
  globalThis[key] = state;
  t.after(async () => { delete globalThis[key]; await rm(directory, { recursive: true, force: true }); });
  const sourceFiles = new Map(Object.entries({ ...expose, ...transforms }).map(([path]) => [fileURLToPath(new URL(path, sourceRoot)), path]));
  const output = `${directory}/consumers.mjs`;
  await build({
    stdin: { contents: Object.entries(exports).map(([path, names]) => `export { ${names.join(", ")} } from ${JSON.stringify(fileURLToPath(new URL(path, sourceRoot)))};`).join("\n"), resolveDir: fileURLToPath(sourceRoot), loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    define: { "import.meta.env": JSON.stringify({ BASE_URL: "/", MODE: "test", DEV: false, PROD: true }) },
    loader: { ".css": "empty" }, logLevel: "silent",
    plugins: [{ name: "catalog-consumer-test-context", setup(builder) {
      builder.onResolve({ filter: /(?:^|\/)i18n\.js$/ }, () => ({ path: "i18n", namespace: "catalog-test" }));
      builder.onLoad({ filter: /.*/, namespace: "catalog-test" }, () => ({ contents:
        `export function useI18n() { const s = globalThis[${JSON.stringify(key)}]; return { locale: s.locale, t: s.t }; }`, loader: "js" }));
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        const relative = sourceFiles.get(path);
        if (!relative) return undefined;
        let contents = await readFile(path, "utf8");
        for (const seam of transforms[relative] ?? []) {
          assert.equal(contents.split(seam.anchor).length - 1, 1, `test seam must uniquely match ${relative}: ${seam.anchor}`);
          contents = contents.replace(seam.anchor, seam.replace(key));
        }
        const names = expose[relative];
        if (names) {
          for (const name of names) assert.equal((contents.match(new RegExp(`(?:^|\\n)(?:async )?function ${name}\\b`, "g")) ?? []).length, 1, `unique private consumer ${name}`);
          contents += `\nexport { ${names.join(", ")} };\n`;
        }
        return { contents, loader: path.endsWith("x") ? "tsx" : "ts", resolveDir: fileURLToPath(new URL(".", pathToFileURL(path))) };
      });
    } }],
  });
  const previousWindow = globalThis.window;
  if (previousWindow === undefined) globalThis.window = {};
  let module;
  try { module = await import(pathToFileURL(output).href); }
  finally { if (previousWindow === undefined) delete globalThis.window; }
  return {
    module, state,
    async select(locale, missingKeys = []) {
      state.locale = locale;
      state.messages = { ...(await loadCatalog(locale)).messages };
      for (const message of missingKeys) delete state.messages[message];
      state.calls.length = 0;
      return state.t;
    },
    render(Component, props) { return renderToStaticMarkup(React.createElement(Component, props)); },
  };
}
