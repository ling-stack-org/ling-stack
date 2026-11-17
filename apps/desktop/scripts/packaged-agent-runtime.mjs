import { build } from "esbuild";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(desktopRoot, "../..");

/** Embed sandbox resources in the same CLI bytes that the publication gate pins. */
export async function preparePackagedAgentRuntime({ sourceInputs } = {}) {
  const authored = Boolean(sourceInputs), extension = authored ? "ts" : "js", directory = authored ? "src" : "dist";
  const ownedModule = (name, path) => realpathSync(resolve(repositoryRoot, "packages", name, directory, `${path}.${extension}`));
  const scriptModule = ownedModule("runner-pi", "script-runtime");
  const intelligenceModule = ownedModule("daemon", "features/runs/code-intelligence");
  const queryModule = ownedModule("daemon", "runtime/code-intelligence/query");
  const codemodeRoot = realpathSync(resolve(repositoryRoot, "packages/runner-pi/node_modules/@earendil-works/pi-codemode"));
  const codemodeManifest = JSON.parse(readFileSync(resolve(codemodeRoot, "package.json"), "utf8"));
  const workerExport = codemodeManifest.exports?.["./worker"]?.import;
  if (workerExport !== "./dist/runtime/worker.js") throw new Error("packaged_script_worker_export_invalid");
  const wasmPath = createRequire(resolve(codemodeRoot, "package.json")).resolve("quickjs-wasi/quickjs.wasm");
  const wasm = readFileSync(wasmPath);
  if (!wasm.length || wasm.length > 8 * 1024 * 1024) throw new Error("packaged_script_wasm_invalid");
  const libraryRoot = realpathSync(resolve(repositoryRoot, "packages/daemon/node_modules/typescript-language-service/lib"));
  const libraries = {};
  let libraryBytes = 0;
  for (const name of readdirSync(libraryRoot).filter(name => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)).sort()) {
    const bytes = readFileSync(resolve(libraryRoot, name));
    libraryBytes += bytes.length;
    if (libraryBytes > 8 * 1024 * 1024) throw new Error("packaged_code_libraries_limit");
    libraries[name] = bytes.toString("utf8");
  }
  if (!Object.hasOwn(libraries, "lib.es2022.full.d.ts")) throw new Error("packaged_code_libraries_missing");
  const load = path => sourceInputs ? sourceInputs.loadSource(path) : {
    contents: readFileSync(path, "utf8"), loader: "js", resolveDir: dirname(path),
  };
  const replace = (contents, name, sentinel, value) => {
    const marker = `const ${name}${authored ? ": string" : ""} = ${JSON.stringify(sentinel)};`;
    if (contents.split(marker).length !== 2) throw new Error(`packaged_agent_runtime_marker_invalid:${name}`);
    return contents.replace(marker, () => `const ${name}${authored ? ": string" : ""} = ${JSON.stringify(value)};`);
  };
  const scriptWorker = await build({
    absWorkingDir: desktopRoot, entryPoints: [resolve(codemodeRoot, workerExport)], bundle: true,
    platform: "node", format: "esm", write: false, metafile: true, target: "es2022",
  });
  const intelligenceWorker = await build({
    absWorkingDir: desktopRoot, entryPoints: [ownedModule("daemon", "runtime/code-intelligence/worker")], bundle: true,
    platform: "node", format: "cjs", write: false, metafile: true, target: "es2022",
    ...(sourceInputs ? { tsconfigRaw: sourceInputs.tsconfigRaw } : {}),
    plugins: [{
      name: "packaged-code-standard-libraries",
      setup(plugin) {
        plugin.onLoad({ filter: /runtime[\\/]code-intelligence[\\/]query\.(?:ts|js)$/ }, args => {
          if (realpathSync(args.path) !== queryModule) throw new Error("packaged_code_query_module_changed");
          const loaded = load(queryModule);
          return { ...loaded, contents: replace(loaded.contents, "embeddedCodeIntelligenceLibraries",
            "NO_PACKAGED_CODE_INTELLIGENCE_LIBRARIES", JSON.stringify(libraries)) };
        });
      },
    }, ...(sourceInputs ? [sourceInputs.plugin] : [])],
  });
  const resources = new Map([
    [scriptModule, [["embeddedScriptWorkerSource", "NO_PACKAGED_SCRIPT_WORKER", scriptWorker.outputFiles[0].text],
      ["embeddedScriptWasmBase64", "NO_PACKAGED_SCRIPT_WASM", wasm.toString("base64")]]],
    [intelligenceModule, [["embeddedCodeIntelligenceWorkerSource", "NO_PACKAGED_CODE_INTELLIGENCE_WORKER", intelligenceWorker.outputFiles[0].text]]],
  ]);
  const visits = new Set();
  return {
    workerResults: [scriptWorker, intelligenceWorker],
    plugin: {
      name: "packaged-agent-runtime-resources",
      setup(plugin) {
        plugin.onLoad({ filter: /(?:script-runtime|code-intelligence)\.(?:ts|js)$/ }, args => {
          const path = realpathSync(args.path), values = resources.get(path);
          if (!values) return;
          if (visits.has(path)) throw new Error("packaged_agent_runtime_module_reloaded");
          visits.add(path);
          const loaded = load(path);
          let contents = loaded.contents;
          for (const [name, sentinel, value] of values) contents = replace(contents, name, sentinel, value);
          return { ...loaded, contents };
        });
      },
    },
    assertIncluded() {
      if (visits.size !== resources.size) throw new Error("packaged_agent_runtime_resources_not_bundled");
    },
  };
}
