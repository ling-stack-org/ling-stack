import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AssuranceError, MAX_JSON_BYTES, readBoundFile, requireCondition, sha256 } from "./manifest.mjs";

// Load only the two existing pure Core modules, without initializing the Core barrel or a Store.
export async function loadCoreGrader(repoRoot) {
  const paths = ["packages/core/src/harness/evaluation-rule-grader.ts", "packages/core/src/harness/evaluation-json.ts"];
  const bytes = await Promise.all(paths.map(async path => (await readBoundFile(repoRoot, path)).bytes));
  for (const [index, path] of paths.entries()) {
    let frozen;
    try { frozen = execFileSync("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: repoRoot, maxBuffer: MAX_JSON_BYTES, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { throw new AssuranceError("source_unavailable", "Core grader Git source is unavailable locally."); }
    requireCondition(sha256(frozen) === sha256(bytes[index]), "artifact_digest_mismatch", "Core grader must match its checked-out Git revision before loading.");
  }
  const sourceDigests = Object.fromEntries(paths.map((path, index) => [path, sha256(bytes[index])]));
  const urls = paths.map((path, index) => `${pathToFileURL(resolve(repoRoot, path)).href}?assurance=${sha256(bytes[index])}`);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === urls[0] && specifier === "./evaluation-json.js") return { url: urls[1], shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  let rule; let json;
  try { [rule, json] = await Promise.all([import(urls[0]), import(urls[1])]); }
  finally { hook.deregister(); }
  const after = await Promise.all(paths.map(async path => (await readBoundFile(repoRoot, path)).bytes));
  requireCondition(after.every((value, index) => sha256(value) === sha256(bytes[index])), "snapshot_changed", "Core grader source changed while loading.");
  return { grade: rule.gradeDeterministicRunEvaluation, canonical: json.canonicalRunEvaluationJson,
    valueDigest: json.digestRunEvaluationValue, sourceDigests };
}
