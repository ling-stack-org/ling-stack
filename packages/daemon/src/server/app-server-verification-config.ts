import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { LingAppServerVerificationCheckKind } from "@ling-stack/contracts";

export interface AppServerVerificationRecipeConfig {
  readonly id: string;
  readonly kind: LingAppServerVerificationCheckKind;
  readonly label: string;
  readonly workspaceRoot: string;
  readonly argv: readonly [string, ...string[]];
  /** Git-relative files or directories that select the recipe. */
  readonly paths?: readonly string[];
  readonly required: boolean;
  readonly verifier?: {
    readonly coverage: string;
    readonly sources: readonly { readonly path: string; readonly sha256: string }[];
  };
}

/** Registration comes from the Host startup configuration. */
export function resolveVerificationRecipes(
  configured: readonly AppServerVerificationRecipeConfig[] | undefined,
): readonly AppServerVerificationRecipeConfig[] {
  const path = process.env.LING_STACK_APP_SERVER_VERIFICATION_RECIPES_FILE;
  let input = configured;
  if (input === undefined && path) {
    try { input = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("The App Server verification recipe file must contain valid JSON."); }
  }
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 16) throw new Error("App Server supports at most 16 configured verification recipes.");
  const seen = new Set<string>();
  return input.map((value: AppServerVerificationRecipeConfig) => {
    if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.id)
      || !["typecheck", "test", "command", "browser", "platform"].includes(value.kind)
      || typeof value.label !== "string" || !value.label.trim() || value.label.length > 160
      || typeof value.required !== "boolean"
      || typeof value.workspaceRoot !== "string" || !isAbsolute(value.workspaceRoot)
      || !Array.isArray(value.argv) || !value.argv.length || value.argv.length > 64
      || !value.argv.every(arg => typeof arg === "string" && arg.length <= 2048 && !arg.includes("\0"))
      || !isAbsolute(value.argv[0])
      || value.paths !== undefined && (!Array.isArray(value.paths) || !value.paths.length || value.paths.length > 64
        || !value.paths.every(path => typeof path === "string" && path.length <= 512
          && path.split("/").every(segment => segment && segment !== "." && segment !== ".." && !/[:\\\0]/u.test(segment))))) {
      throw new Error("Invalid App Server verification recipe configuration.");
    }
    const workspaceRoot = realpathSync(value.workspaceRoot);
    const key = JSON.stringify([workspaceRoot, value.id]);
    if (seen.has(key)) throw new Error("Duplicate App Server verification recipe for a workspace.");
    seen.add(key);
    const verifier = value.verifier === undefined ? undefined : normalizeVerifier(value.verifier);
    return { ...value, workspaceRoot, verifier, argv: [value.argv[0], ...value.argv.slice(1)] as const };
  });
}

function normalizeVerifier(value: NonNullable<AppServerVerificationRecipeConfig["verifier"]>) {
  if (!value || typeof value.coverage !== "string" || !value.coverage.trim() || value.coverage.length > 2000
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16) {
    throw new Error("Invalid App Server verifier coverage or source list.");
  }
  const sources = value.sources.map((source: (typeof value.sources)[number]) => {
    if (!source || typeof source.path !== "string" || !isAbsolute(source.path)
      || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(source.sha256)) {
      throw new Error("App Server verifier sources require absolute paths and SHA-256 digests.");
    }
    return { path: normalize(source.path), sha256: source.sha256 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(sources.map(source => source.path)).size !== sources.length) throw new Error("Duplicate App Server verifier source.");
  return { coverage: value.coverage.trim(), sources };
}
