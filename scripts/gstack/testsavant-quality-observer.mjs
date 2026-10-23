import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, relative, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";

// Observation binds this measurement to its actual JS/native inputs, not to
// every possible future branch of the inference runtime.
export function observeTestsavantQualityRuntime(root) {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error("testsavant_quality_runtime_invalid");
  const inputs = new Map(), addons = new Set();
  const local = absolute => {
    const path = relative(root, absolute).split("\\").join("/");
    return path && !isAbsolute(path) && path !== ".." && !path.startsWith("../") ? path : undefined;
  };
  function record(absolute) {
    const path = local(absolute), before = lstatSync(absolute);
    if (!path || realpathSync(absolute) !== absolute || !before.isFile() || before.isSymbolicLink()
      || before.size > 128 * 1024 ** 2) throw new Error("testsavant_quality_dependency_invalid");
    const bytes = readFileSync(absolute), after = lstatSync(absolute);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) throw new Error("testsavant_quality_dependency_changed");
    const value = { path, sizeBytes: bytes.length, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    if (inputs.has(path) && JSON.stringify(inputs.get(path)) !== JSON.stringify(value)) throw new Error("testsavant_quality_dependency_changed");
    inputs.set(path, value);
  }
  const hook = registerHooks({ load(url, context, next) {
    if (url.startsWith("file:") && local(fileURLToPath(url))) record(fileURLToPath(url));
    return next(url, context);
  } });
  const original = process.dlopen;
  process.dlopen = function(module, filename, ...args) {
    const canonical = realpathSync(filename);
    if (filename !== canonical && (process.platform !== "win32" || filename !== toNamespacedPath(canonical))) {
      throw new Error("testsavant_quality_dependency_invalid");
    }
    record(canonical); const value = original.call(this, module, filename, ...args);
    addons.add(local(canonical)); return value;
  };
  return {
    finish() {
      try {
        const sharedObjects = process.report.getReport().sharedObjects.filter(path => local(path));
        for (const path of sharedObjects) record(path);
        for (const path of [...inputs.keys()]) {
          let directory = dirname(join(root, path));
          while (directory === root || local(directory)) {
            const metadata = join(directory, "package.json");
            try { lstatSync(metadata); record(metadata); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            if (directory === root) break;
            directory = dirname(directory);
          }
        }
        for (const path of [...inputs.keys()]) record(join(root, path));
        return { inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
          addons: [...addons].sort(), sharedObjects: sharedObjects.map(local).sort() };
      } finally { hook.deregister(); process.dlopen = original; }
    },
  };
}
