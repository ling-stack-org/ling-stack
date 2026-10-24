import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildGstackNodeServerResource, buildGstackSecuritySidecarResource } from "./build-node-server-resource.mjs";
import { buildGstackDiagramResource } from "./build-diagram-resource.mjs";
import { buildManagedGstackNodeServerResource } from "./build-managed-node-server.mjs";

const [kind, rootArgument, outputArgument, ...extra] = process.argv.slice(2);
if (!rootArgument || !["node-server", "node-server-download", "upstream-node-server", "security-sidecar", "diagram"].includes(kind) || extra.length) {
  throw new Error("Usage: build-portable-resources.ts <node-server|node-server-download|upstream-node-server|security-sidecar|diagram> <runtime-root> [output-root]");
}
const root = resolve(rootArgument);

const reviewed = JSON.parse(await readFile(new URL("./reviewed-source-bundle.json", import.meta.url), "utf8"));
const manifests = [];
for (const name of ["manifest.json", "source-manifest.json"]) {
  const path = join(dirname(root), name);
  if (await lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) manifests.push(path);
}
if (manifests.length !== 1) throw new Error(`gstack_${kind.replaceAll("-", "_")}_source_manifest_ambiguous`);
const build = kind === "node-server" || kind === "node-server-download" ? buildManagedGstackNodeServerResource
  : kind === "upstream-node-server" ? buildGstackNodeServerResource
  : kind === "security-sidecar" ? buildGstackSecuritySidecarResource : buildGstackDiagramResource;
const result = await build({ runtimeRoot: root, outputRoot: outputArgument ? resolve(outputArgument) : root,
  ...(kind === "node-server-download" ? { modelMode: "download-required" } : {}),
  sourceManifestPath: manifests[0], expectedSourceManifestChecksum: reviewed.manifestChecksum });
console.log(`built ${kind} with ${result.inputs.length} bound inputs and repeated byte-identical compilation`);
