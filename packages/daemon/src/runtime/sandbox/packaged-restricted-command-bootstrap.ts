import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  digestElectronNodeResource,
  ELECTRON_NODE_RESOURCE_PATHS,
} from "./electron-node-resources.js";
import type { RestrictedCommandRuntimeConfig } from "./restricted-command-runtime.js";
import { prepareOriginalPackagedCodesignSource, readOriginalPackagedCodesignSource,
  closeOriginalPackagedCodesignIdentity, createOriginalPackagedCodesignInvocation,
  createUnverifiedPackagedCodesignInvocation, readOriginalPackagedCodesignActorEntry } from "./packaged-codesign-host-source.js";

/** Exact singleton from the original source, not a generic same-name factory or caller resolver. */
export const PACKAGED_CODESIGN_ACTOR_ENTRY = readOriginalPackagedCodesignActorEntry();

interface NativeBuildManifest {
  readonly schemaVersion: number;
  readonly helperName: string;
  readonly helperVersion: string;
  readonly target: string;
  readonly binary: { readonly filename: string; readonly sizeBytes: number };
}
interface BootstrapDependencies {
  readonly executablePath?: string;
  readonly architecture?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly verifyBundle?: (appBundlePath: string) => void;
}
const hashFile = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function requireBootstrap(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function fixedFile(path: string, executable: boolean): string {
  const stat = lstatSync(path);
  requireBootstrap(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path
    && stat.size > 0 && stat.size <= 512 * 1024 * 1024
    && (stat.mode & 0o022) === 0 && (!executable || (stat.mode & 0o111) !== 0),
  "restricted_command_packaged_resource_invalid");
  return path;
}
function verifyFinalMacosBundle(path: string, originalDefaultHostSource = false): void {
  const source = originalDefaultHostSource ? prepareOriginalPackagedCodesignSource() : undefined;
  let failed = false, failure: unknown;
  try {
    if (source) requireBootstrap(readOriginalPackagedCodesignSource(source).appBundlePath === path,
      "packaged_codesign_host_source_invalid");
    const record = source ? createOriginalPackagedCodesignInvocation(source)
      : createUnverifiedPackagedCodesignInvocation(["--verify", "--deep", "--strict", path]);
    // Candidate profiles are not certified Host actors: no Run actor is borrowed,
    // and both pre-Supervisor and no-stage entry history remain sticky unknown.
    const result = PACKAGED_CODESIGN_ACTOR_ENTRY.invoke(undefined, record);
    requireBootstrap(!result.error && !result.signal && result.status === 0,
      "restricted_command_bundle_identity_invalid");
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    if (source) try { closeOriginalPackagedCodesignIdentity(source); }
    catch (closeError) {
      if (failed) throw new AggregateError([failure, closeError], "packaged_codesign_identity_close_unknown");
      throw closeError;
    }
  }
}
function parseManifest(path: string, target: string): NativeBuildManifest {
  const bytes = readFileSync(fixedFile(path, false));
  requireBootstrap(bytes.length <= 2 * 1024 * 1024, "restricted_command_manifest_invalid");
  let manifest: NativeBuildManifest;
  try { manifest = JSON.parse(bytes.toString("utf8")) as NativeBuildManifest; }
  catch { throw new Error("restricted_command_manifest_invalid"); }
  requireBootstrap(manifest?.schemaVersion === 1 && manifest.helperName === "ling-sandbox-runner"
    && /^[\w.+-]{1,128}$/u.test(manifest.helperVersion) && manifest.target === target
    && manifest.binary?.filename === "ling-sandbox-runner"
    && Number.isSafeInteger(manifest.binary.sizeBytes) && manifest.binary.sizeBytes > 0,
  "restricted_command_manifest_invalid");
  return manifest;
}

/**
 * The only production discovery route. No workspace path, PATH lookup, model
 * field or arbitrary environment value can select executable resources.
 */
export function readPackagedRestrictedCommandConfig(
  dependencies: BootstrapDependencies = {},
): RestrictedCommandRuntimeConfig | undefined {
  const environment = dependencies.environment ?? process.env;
  if (environment.LING_STACK_PACKAGED_DESKTOP !== "1") return undefined;
  requireBootstrap(process.platform === "darwin" && environment.ELECTRON_RUN_AS_NODE === "1",
    "restricted_command_packaged_platform_invalid");
  const executable = realpathSync(dependencies.executablePath ?? process.execPath);
  const contents = dirname(dirname(executable)), appBundle = dirname(contents);
  requireBootstrap(basename(dirname(executable)) === "MacOS" && basename(contents) === "Contents"
    && basename(appBundle).endsWith(".app") && realpathSync(appBundle) === appBundle,
  "restricted_command_packaged_layout_invalid");
  if (dependencies.verifyBundle) dependencies.verifyBundle(appBundle);
  else verifyFinalMacosBundle(appBundle, Reflect.ownKeys(dependencies).length === 0);
  const architecture = dependencies.architecture ?? process.arch;
  const target = architecture === "arm64" ? "aarch64-apple-darwin"
    : architecture === "x64" ? "x86_64-apple-darwin" : "";
  requireBootstrap(target, "restricted_command_packaged_architecture_invalid");
  const resourceRoot = join(contents, "Resources", "restricted-command");
  const manifest = parseManifest(join(resourceRoot, "manifest.json"), target);
  const helper = fixedFile(join(resourceRoot, manifest.binary.filename), true);
  // Electron Builder signs nested executables after staging, so the final
  // sealed helper is expected to be larger than the unsigned build artifact.
  // The manifest remains provenance evidence; the verified final App bundle
  // and the hash captured below are the runtime authority.
  const signedSize = lstatSync(helper).size;
  requireBootstrap(signedSize >= manifest.binary.sizeBytes
    && signedSize <= manifest.binary.sizeBytes + 1024 * 1024,
    "restricted_command_packaged_resource_invalid");
  const resources = ELECTRON_NODE_RESOURCE_PATHS.map(relativePath => ({
    relativePath,
    sha256: digestElectronNodeResource(fixedFileOrDirectory(join(contents, relativePath))),
  }));
  return Object.freeze({
    inputHelper: Object.freeze({ path: helper, sha256: hashFile(helper), version: manifest.helperVersion }),
    executables: Object.freeze({
      node: Object.freeze({
        path: fixedFile(executable, true),
        sha256: hashFile(executable),
        runtime: Object.freeze({ kind: "electron_node_v1" as const, resources: Object.freeze(resources) }),
      }),
    }),
  });
}
function fixedFileOrDirectory(path: string): string {
  const stat = lstatSync(path);
  requireBootstrap(!stat.isSymbolicLink() && realpathSync(path) === path
    && (stat.isFile() || stat.isDirectory()) && (stat.mode & 0o022) === 0,
  "restricted_command_packaged_resource_invalid");
  return path;
}
