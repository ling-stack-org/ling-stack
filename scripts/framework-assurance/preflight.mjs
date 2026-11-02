import { resolve } from "node:path";
import { exactObject, identifier, nonempty, parseJson, parseSuite, parseTask, readArtifact, readBoundFile, requireCondition, safeRelativePath, verifySource } from "./manifest.mjs";
import { loadCoreGrader } from "./grader.mjs";

export const DEFAULT_SUITE = "suites/framework-v3.json";

export async function preflight({ repoRoot, fixtureRoot = resolve(repoRoot, "fixtures/framework-assurance"), suitePath = DEFAULT_SUITE }) {
  const suiteFile = await readBoundFile(fixtureRoot, suitePath);
  const suite = parseSuite(parseJson(suiteFile.bytes));
  const tasks = [];
  for (const entry of suite.tasks) {
    const task = parseTask((await readArtifact(fixtureRoot, entry.task)).value);
    requireCondition(task.taskId === entry.taskId && task.taskVersion === entry.taskVersion, "invalid_manifest", "Suite and task identities differ.");
    await verifySource(repoRoot, task.source);
    const prompt = await readArtifact(fixtureRoot, task.prompt);
    nonempty(prompt.bytes.toString("utf8"), "task prompt");
    const profile = (await readArtifact(fixtureRoot, task.validationProfile.artifact)).value;
    exactObject(profile, ["schemaVersion", "profileId", "profileVersion", "mode", "checks"], "validation profile");
    identifier(profile.profileId, "profile id"); identifier(profile.profileVersion, "profile version");
    requireCondition(profile.schemaVersion === 1 && profile.profileId === task.validationProfile.id
      && profile.profileVersion === task.validationProfile.version && profile.mode === "offline_control_only",
    "invalid_manifest", "Validation profile does not match this offline task.");
    requireCondition(Array.isArray(profile.checks) && profile.checks.length > 0 && profile.checks.length <= 100, "invalid_manifest", "Validation checks are required.");
    profile.checks.forEach(item => nonempty(item, "validation check"));
    for (const path of task.provenance.anchors) { safeRelativePath(path); await readBoundFile(repoRoot, path); }
    if (task.provenance.injection) await readArtifact(fixtureRoot, task.provenance.injection);
    const rule = (await readArtifact(fixtureRoot, task.ruleCase)).value;
    const expected = (await readArtifact(fixtureRoot, task.expected)).value;
    const controls = {};
    for (const [name, control] of Object.entries(task.controls)) controls[name] = (await readArtifact(fixtureRoot, control.candidate)).value;
    tasks.push({ task, taskByteDigest: entry.task.sha256, profile, rule, expected, controls });
  }
  const core = await loadCoreGrader(repoRoot);
  // Verify every source pin before importing the authoritative pure grader.
  for (const { rule, expected } of tasks) core.grade({ caseDefinition: rule, baseline: expected, candidate: expected });
  return { schemaVersion: 1, kind: "offline_preflight", suite, suiteByteDigest: suiteFile.sha256, tasks,
    graderSourceDigests: core.sourceDigests, externalProviderCalls: 0, ordinaryRunsDispatched: 0,
    userStoresInitialized: 0, taskCodeExecuted: false };
}

export function assessControl({ core, task, rule, expected, candidate }) {
  const present = candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    && task.requiredEvidence.every(key => Object.hasOwn(candidate, key) && candidate[key] !== null);
  if (!present) return { assessment: "invalid_evidence", score: null, rationale: null };
  const result = core.grade({ caseDefinition: rule, baseline: expected, candidate });
  return { assessment: result.verdict, score: result.score, rationale: result.rationale };
}
