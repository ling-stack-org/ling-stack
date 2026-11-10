import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyImageParserSecurityPatches } from "./patch-image-parsers.mjs";
import { applyLegacyNodeFetchURLPatch } from "./patch-legacy-url-fallback.mjs";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const checksum = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const unpatchedSprintfChecksum = "sha256:95add43f116385be221745307fae02d06751b01d4f939df1debb17dbe2ebf4eb";

export async function applyGstackRuntimeSecurityPatches({ runtimeRoot, env }) {
  const root = await realpath(runtimeRoot);
  const require = createRequire(join(root, "package.json"));
  const packageRoot = await realpath(dirname(require.resolve("sprintf-js/package.json")));
  const location = relative(root, packageRoot);
  if (isAbsolute(location) || location === ".." || location.startsWith("../") || location.startsWith("..\\")) {
    throw new Error("gstack_security_dependency_escape");
  }
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const source = join(packageRoot, "src/sprintf.js");
  const beforeChecksum = checksum(await readFile(source));
  if (metadata.version !== "1.1.3" || beforeChecksum !== unpatchedSprintfChecksum) {
    throw new Error("gstack_sprintf_input_changed_review_patch");
  }
  const patchSource = join(scriptRoot, "../../patches/sprintf-js@1.1.3.patch");
  const patch = join(root, "patches/ling-sprintf-js@1.1.3.patch");
  await mkdir(dirname(patch), { recursive: true });
  await copyFile(patchSource, patch);
  // Run outside the enclosing repository context so Git applies only to this
  // isolated installed dependency, never to the application's source checkout.
  const options = { cwd: packageRoot, env: { ...env, GIT_CEILING_DIRECTORIES: dirname(packageRoot), GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", timeout: 30_000 };
  execFileSync("git", ["apply", "--check", patch], options);
  execFileSync("git", ["apply", patch], options);
  const { sprintf } = require("sprintf-js");
  for (const type of ["f", "e", "g"]) {
    if (sprintf(`%.10000${type}`, 1.25) !== sprintf(`%.100${type}`, 1.25)) throw new Error("gstack_sprintf_patch_behavior_failed");
  }
  return [{
    package: "sprintf-js", version: metadata.version, advisory: "GHSA-hp3w-g68c-fv3c",
    path: `${location.split("\\").join("/")}/src/sprintf.js`,
    beforeChecksum, afterChecksum: checksum(await readFile(source)),
    patchPath: "patches/ling-sprintf-js@1.1.3.patch", patchChecksum: checksum(await readFile(patch)),
  }, ...await applyImageParserSecurityPatches({ runtimeRoot: root }),
  ...(await applyLegacyNodeFetchURLPatch({ runtimeRoot: root })).patches];
}
