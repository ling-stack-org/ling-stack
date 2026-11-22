import { randomUUID } from "node:crypto";
import { link, realpath, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { LingAppServerInstructionsInitParams, LingAppServerInstructionsInitResult } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { collectProjectInstructions, projectInstructionDirectory, readProjectText, textDigest } from "./project-instructions.js";

export async function initializeProjectInstructions(cwd: string, input: LingAppServerInstructionsInitParams): Promise<LingAppServerInstructionsInitResult> {
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200
    || input.mode !== undefined && input.mode !== "preview" && input.mode !== "apply"
    || input.taskPath !== undefined && typeof input.taskPath !== "string"
    || input.expectedWorkspaceRevision !== undefined && typeof input.expectedWorkspaceRevision !== "string") {
    throw new HttpError(400, "invalid_params", "Supply a valid project instruction mode, path, revision and idempotency key.");
  }
  const selected = input.sources ?? ["README", "CI", "package_scripts", "existing_rules"];
  if (!Array.isArray(selected) || !selected.every(source => ["README", "CI", "package_scripts", "existing_rules"].includes(source))) {
    throw new HttpError(400, "invalid_params", "Unknown project instruction source.");
  }
  const directory = await projectInstructionDirectory(cwd, input.taskPath);
  const { root, manifest } = await collectProjectInstructions(cwd, [directory]);
  const target = relative(root, join(directory, "AGENTS.md"));
  const sources = selected.includes("existing_rules") ? [...manifest.sources] : [];
  const inputs = [
    ["README", "README.md"], ["CI", ".github/workflows/ci.yml"], ["package_scripts", "package.json"],
  ] as const;
  const contents = new Map<string, string>();
  for (const [kind, path] of inputs) {
    if (!selected.includes(kind)) continue;
    const text = await readProjectText(root, path);
    if (typeof text !== "string") continue;
    contents.set(kind, text);
    sources.push({ path, scope: ".", digest: textDigest(text), applicable: true });
  }
  const draft = renderDraft(contents);
  const workspaceRevision = textDigest(JSON.stringify([root, target, sources.filter(source => source.path !== target), draft]));
  const result = { proposalId: `instructions_${workspaceRevision}`, sources, workspaceRevision, draft: { path: target, content: draft } };
  if (input.mode === "apply" && !input.expectedWorkspaceRevision) {
    return { ...result, status: "blocked", conflicts: ["apply requires expectedWorkspaceRevision"] };
  }
  const existing = await readProjectText(root, target);
  const override = await readProjectText(root, relative(root, join(directory, "AGENTS.override.md")));
  const conflicts: string[] = [];
  if (input.mode === "apply" && input.expectedWorkspaceRevision !== workspaceRevision) conflicts.push("Workspace revision changed since the preview.");
  if (override !== undefined) conflicts.push("AGENTS.override.md already governs the target directory.");
  if (existing !== undefined && existing !== draft) conflicts.push("AGENTS.md already exists in the target directory.");
  if (input.mode !== "apply") return { ...result, status: "draft", conflicts };
  if (conflicts.length) return { ...result, status: "blocked", conflicts };
  if (existing === draft) return { ...result, status: "applied", conflicts };

  const temporary = join(directory, `.ling-instructions-${randomUUID()}.tmp`);
  await writeFile(temporary, draft, { flag: "wx", mode: 0o644 });
  try {
    if (await realpath(directory) !== directory) return { ...result, status: "blocked", conflicts: ["Instruction directory changed since the preview."] };
    await link(temporary, join(root, target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readProjectText(root, target) !== draft) return { ...result, status: "blocked", conflicts: ["AGENTS.md was created since the preview."] };
  } finally {
    await unlink(temporary);
  }
  return { ...result, status: "applied", conflicts };
}

function renderDraft(contents: ReadonlyMap<string, string>): string {
  const lines = ["# Project instructions", ""];
  if (contents.has("README")) lines.push("Read `README.md` for repository setup and overview.", "");
  let packageJson: { packageManager?: unknown; scripts?: Record<string, unknown> } = {};
  try { packageJson = JSON.parse(contents.get("package_scripts") ?? "{}") ?? {}; } catch { /* Optional source. */ }
  const manager = typeof packageJson.packageManager === "string" ? /^(pnpm|npm|yarn|bun)@/u.exec(packageJson.packageManager)?.[1] : undefined;
  const checks = ["typecheck", "typecheck:ci", "lint", "test", "test:ci", "build"].filter(name => typeof packageJson.scripts?.[name] === "string");
  if (checks.length || contents.has("CI")) {
    lines.push("## Verification", "");
    for (const check of checks) lines.push(`- Use \`${manager ?? "npm"} run ${check}\` for the repository's ${check} check.`);
    if (contents.has("CI")) lines.push("- See `.github/workflows/ci.yml` for CI checks and their scope.");
    lines.push("");
  }
  return lines.join("\n");
}
