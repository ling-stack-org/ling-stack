import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { buildTestsavantComponent } from "./build-testsavant-component.mjs";
import { buildGstackNodeServerResource } from "./build-node-server-resource.mjs";
import { readGstackClosureFileRecord } from "./verify-shared-command-closure.mjs";
import { requireResourceLease, within } from "./resource-workspace.mjs";

/** The default server build admits one worker; comparison modules never ship. */
export async function buildManagedGstackNodeServerResource(options) {
  const lease = await requireResourceLease();
  const output = resolve(options.outputRoot ?? options.runtimeRoot);
  const staging = dirname(dirname(output));
  const privateNative = output === resolve(options.runtimeRoot) && basename(output) === "runtime"
    && basename(dirname(output)) === "candidate" && basename(staging).startsWith(".gstack-native-stage-")
    && dirname(staging) === join(lease.root, "artifacts/native");
  if (!within(lease.scratchPath, output) && !privateNative) throw new Error("testsavant_private_output_required");
  const temporary = await mkdtemp(join(tmpdir(), ".ling-testsavant-build-"));
  const owned = [];
  let serverBuilt = false;
  try {
    const component = await buildTestsavantComponent({ runtimeRoot: options.runtimeRoot, outputRoot: temporary,
      sourceManifestPath: options.sourceManifestPath, sourceManifestChecksum: options.expectedSourceManifestChecksum,
      productionOnly: true });
    const receipt = join(temporary, "testsavant-component.json");
    const checksum = (await readGstackClosureFileRecord(receipt)).checksum;
    const result = await buildGstackNodeServerResource({ ...options,
      testsavantComponent: { root: temporary, checksum } });
    serverBuilt = true;
    const dist = join(output, "browse/dist");
    for (const path of [output, join(output, "browse"), dist]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error("testsavant_output_alias");
    }
    for (const name of [component.artifacts[0].path, "testsavant-component.json"]) {
      const path = join(dist, name), handle = await open(path, "wx", 0o600);
      owned.push(path);
      try { await handle.writeFile(await readFile(join(temporary, name))); }
      finally { await handle.close(); }
    }
    if ((await readGstackClosureFileRecord(join(dist, "testsavant-component.json"))).checksum !== checksum ||
      (await readGstackClosureFileRecord(join(dist, component.artifacts[0].path))).checksum !== component.artifacts[0].checksum) {
      throw new Error("testsavant_emitted_output_changed");
    }
    return result;
  } catch (error) {
    for (const path of owned) await rm(path);
    if (serverBuilt) for (const name of ["server-node.mjs", "bun-polyfill.cjs", "node-server-build-provenance.json"]) {
      await rm(join(output, "browse/dist", name));
    }
    throw error;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
