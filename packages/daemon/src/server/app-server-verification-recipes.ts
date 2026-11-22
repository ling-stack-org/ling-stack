import { spawn } from "node:child_process";
import type {
  LingAppServerCandidateReference,
  LingAppServerVerificationCheckKind,
  LingAppServerVerificationCheckPlan,
  LingAppServerVerificationCheckStatus,
} from "@ling-stack/contracts";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";

const recipes = [
  { id: "typecheck", kind: "typecheck", label: "Typecheck", argv: ["pnpm", "run", "typecheck:ci"], required: true },
  { id: "test", kind: "test", label: "Tests", argv: ["pnpm", "run", "test"], required: true },
] as const satisfies readonly {
  id: string;
  kind: LingAppServerVerificationCheckKind;
  label: string;
  argv: readonly [string, ...string[]];
  required: boolean;
}[];

export function verificationRecipes(requested: readonly string[] | undefined) {
  const ids = requested?.length ? [...new Set(requested)] : recipes.map(recipe => recipe.id);
  return ids.map(id => {
    const recipe = recipes.find(candidate => candidate.id === id);
    if (recipe) return recipe;
    return { id, kind: inferCheckKind(id), label: id, argv: [] as readonly string[], required: false };
  });
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
  readonly signal: AbortSignal;
}): Promise<LingAppServerVerificationCheckStatus> {
  const recipe = recipes.find(item => item.id === input.check.checkId);
  if (!recipe || input.check.command !== recipe.argv.join(" ") || process.platform === "win32") return "blocked";
  if (input.signal.aborted) return "cancelled";
  const matchesCandidate = async () => {
    const snapshot = await captureCodeAssessmentSnapshot(input.cwd, { type: "working_tree" });
    return snapshot.coverage === "complete" && snapshot.digest === input.candidate.candidateDigest;
  };
  if (!await matchesCandidate()) return "blocked";
  if (input.signal.aborted) return "cancelled";
  const status = await runCheck(recipe.argv, input.cwd, input.signal);
  return status === "passed" && !await matchesCandidate() ? "blocked" : status;
}

function runCheck([file, ...args]: readonly [string, ...string[]], cwd: string, signal: AbortSignal): Promise<LingAppServerVerificationCheckStatus> {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CI: "true" },
    });
    let stopStatus: "cancelled" | "unknown" | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: LingAppServerVerificationCheckStatus) => {
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      signal.removeEventListener("abort", abort);
      resolve(status);
    };
    const stop = (status: "cancelled" | "unknown") => {
      if (stopStatus) return;
      stopStatus = status;
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { stopStatus = "unknown"; }
      cleanupDeadline = setTimeout(() => {
        child.unref();
        finish("unknown");
      }, 5_000);
    };
    const abort = () => stop("cancelled");
    const deadline = setTimeout(() => stop("unknown"), 5 * 60 * 1000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", error => finish(stopStatus ?? ((error as NodeJS.ErrnoException).code === "ENOENT" ? "blocked" : "failed")));
    child.once("close", code => finish(stopStatus ?? (code === 0 ? "passed" : "failed")));
  });
}
