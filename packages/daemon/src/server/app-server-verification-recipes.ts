import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type {
  LingAppServerCandidateReference,
  LingAppServerVerificationCheckKind,
  LingAppServerVerificationCheckPlan,
  LingAppServerVerificationCheckStatus,
  LingAppServerVerificationExecution,
} from "@ling-stack/contracts";
import { redactSecrets } from "@ling-stack/core";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import type { AppServerVerificationRecipeConfig } from "./app-server-verification-config.js";

const defaultRecipes = [
  { id: "typecheck", kind: "typecheck", label: "Typecheck", argv: ["pnpm", "run", "typecheck:ci"], required: true },
  { id: "test", kind: "test", label: "Tests", argv: ["pnpm", "run", "test"], required: true },
] as const satisfies readonly {
  id: string;
  kind: LingAppServerVerificationCheckKind;
  label: string;
  argv: readonly [string, ...string[]];
  required: boolean;
}[];

type VerificationRecipe = AppServerVerificationRecipeConfig | (typeof defaultRecipes)[number];
type VerifierEvidence = Required<Pick<LingAppServerVerificationCheckPlan, "verifierBasisRef" | "coverageDigest" | "producerRefs">>;

export interface AppServerVerificationCheckResult {
  readonly status: LingAppServerVerificationCheckStatus;
  readonly execution?: LingAppServerVerificationExecution;
  readonly verifier?: VerifierEvidence;
}

export function verificationRecipes(
  requested: readonly string[] | undefined,
  configured: readonly AppServerVerificationRecipeConfig[] = [],
  paths?: readonly string[],
) {
  if (!requested?.length) {
    const selected = configured.filter(recipe => {
      const targets = recipe.paths;
      return !targets || paths?.some(path => targets.some(prefix => path === prefix || path.startsWith(prefix + "/")));
    });
    return selected.length ? selected : [...defaultRecipes];
  }
  const recipes: readonly VerificationRecipe[] = [...configured, ...defaultRecipes];
  return [...new Set(requested)].map(id => {
    const recipe = recipes.find(candidate => candidate.id === id);
    if (recipe) return recipe;
    return { id, kind: inferCheckKind(id), label: id, argv: [] as readonly string[], required: false };
  });
}

export function verificationRecipePlan(recipe: ReturnType<typeof verificationRecipes>[number], candidateDigest: string): LingAppServerVerificationCheckPlan {
  const { id, kind, label, argv, required } = recipe;
  const verifier = "verifier" in recipe ? recipe.verifier : undefined;
  const recipeDigest = hash([id, kind, argv, required, verifier]);
  const basis: VerifierEvidence | undefined = verifier && {
    verifierBasisRef: `verify_basis_${recipeDigest}`,
    coverageDigest: hash([id, verifier.coverage, verifier.sources]),
    producerRefs: verifier.sources.map(source => `file:${hash(source.path)}:sha256:${source.sha256}`),
  };
  return {
    checkId: id, kind, label, required,
    ...(argv.length ? { command: "workspaceRoot" in recipe ? id : argv.join(" ") } : {}),
    recipeDigest: "workspaceRoot" in recipe
      ? hash([recipeDigest, candidateDigest])
      : createHash("sha256").update(JSON.stringify({ id, kind, argv, candidateDigest })).digest("hex"),
    ...basis,
  };
}

function inferCheckKind(id: string): LingAppServerVerificationCheckKind {
  if (/type|tsc|compile/u.test(id)) return "typecheck";
  if (/browser|playwright|e2e/u.test(id)) return "browser";
  if (/platform|ios|macos|android/u.test(id)) return "platform";
  if (/test|spec|vitest|jest/u.test(id)) return "test";
  return "command";
}

export async function executeAppServerVerificationCheck(input: {
  readonly cwd: string;
  readonly check: LingAppServerVerificationCheckPlan;
  readonly candidate: LingAppServerCandidateReference;
  readonly recipes?: readonly AppServerVerificationRecipeConfig[];
  readonly signal: AbortSignal;
}): Promise<AppServerVerificationCheckResult> {
  if (process.platform === "win32") return { status: "blocked" };
  const matching = [...(input.recipes ?? []), ...defaultRecipes]
    .filter(recipe => recipe.id === input.check.checkId)
    .map(recipe => ({ recipe, planned: verificationRecipePlan(recipe, input.candidate.candidateDigest) }))
    .find(({ planned }) => planned.recipeDigest === input.check.recipeDigest && planned.command === input.check.command);
  if (!matching) return { status: "blocked" };
  const { recipe, planned } = matching;
  if (input.signal.aborted) return { status: "cancelled" };
  const matchesCandidate = async () => {
    const snapshot = await captureCodeAssessmentSnapshot(input.cwd, { type: "working_tree" });
    return snapshot.coverage === "complete" && snapshot.digest === input.candidate.candidateDigest;
  };
  const sources = "verifier" in recipe ? recipe.verifier?.sources : undefined;
  const matchesSources = () => sources ? matchesVerifierSources(input.cwd, sources) : true;
  if (!await matchesCandidate() || !await matchesSources()) return { status: "blocked" };
  if (input.signal.aborted) return { status: "cancelled" };
  const result = await runCheck(recipe.argv, input.cwd, input.signal);
  if (result.status !== "passed") return result;
  if (!await matchesCandidate() || !await matchesSources()) return { ...result, status: "blocked" };
  return planned.verifierBasisRef && planned.coverageDigest && planned.producerRefs ? {
    ...result, verifier: { verifierBasisRef: planned.verifierBasisRef, coverageDigest: planned.coverageDigest, producerRefs: planned.producerRefs },
  } : result;
}

async function matchesVerifierSources(cwd: string, sources: NonNullable<AppServerVerificationRecipeConfig["verifier"]>["sources"]): Promise<boolean> {
  const repository = await realpath(cwd);
  for (const source of sources) {
    try {
      const canonical = await realpath(source.path);
      const child = relative(repository, canonical);
      const outside = child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child);
      if (!outside || canonical !== source.path) return false;
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) return false;
        const stream = file.createReadStream({ autoClose: false, end: stat.size });
        const sha256 = createHash("sha256");
        for await (const chunk of stream) sha256.update(chunk);
        if (sha256.digest("hex") !== source.sha256) return false;
      } finally {
        await file.close();
      }
    } catch {
      return false;
    }
  }
  return true;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runCheck([file, ...args]: readonly [string, ...string[]], cwd: string, signal: AbortSignal): Promise<AppServerVerificationCheckResult> {
  return new Promise(resolve => {
    const startedAt = new Date().toISOString();
    const child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: "true" },
    });
    const outputLimit = 1024;
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    const capture = (data: Buffer): void => {
      const count = Math.min(data.length, outputLimit - capturedBytes);
      if (count > 0) {
        chunks.push(data.subarray(0, count));
        capturedBytes += count;
      }
      outputTruncated ||= count < data.length;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    let stopStatus: "cancelled" | "unknown" | undefined;
    let timedOut = false;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: LingAppServerVerificationCheckStatus, exitCode: number | null = null) => {
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      signal.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
      resolve({ status, execution: {
        startedAt, endedAt: new Date().toISOString(), exitCode, timedOut, output: redactSecrets(output) as string, outputTruncated,
      } });
    };
    const stop = (status: "cancelled" | "unknown") => {
      if (stopStatus) return;
      stopStatus = status;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { stopStatus = "unknown"; }
      cleanupDeadline = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish("unknown");
      }, 5_000);
    };
    const abort = () => stop("cancelled");
    const deadline = setTimeout(() => {
      timedOut = true;
      stop("unknown");
    }, 5 * 60 * 1000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", error => finish(stopStatus ?? ((error as NodeJS.ErrnoException).code === "ENOENT" ? "blocked" : "failed")));
    child.once("close", code => finish(stopStatus ?? (code === 0 ? "passed" : "failed"), code));
  });
}
