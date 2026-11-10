import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument) throw new Error("Usage: render-upstream.ts <pinned-source> <new-output>");
const source = resolve(sourceArgument);
const output = resolve(outputArgument);
const fromSource = (path: string) => import(pathToFileURL(join(source, path)).href);
const { defineHost } = await fromSource("hosts/define-host.ts");
const { ALL_HOST_CONFIGS, HOST_CONFIG_MAP } = await fromSource("hosts/index.ts");
// Rendering is not runtime certification. T4 must replace advisory host gaps with real enforcement.
const ling = defineHost({
  name: "ling",
  displayName: "Ling Stack",
  cliCommand: "ling-stack",
  defaultModel: "gpt",
  tier: "experimental",
  globalRoot: ".ling-stack/skills/gstack",
  localSkillRoot: ".ling-stack/skills/gstack",
  hostSubdir: ".ling",
  capabilities: { toolExecution: true, questions: "prose", planMode: false, delegation: false, browser: true, safetyHooks: "advisory" },
  generation: { generateMetadata: true, skipSkills: [] },
  pathRewrites: [
    { from: "~/.claude/skills/gstack", to: "$GSTACK_ROOT" },
    { from: ".claude/skills/gstack", to: "$GSTACK_ROOT" },
    { from: ".claude/skills/review", to: "$GSTACK_ROOT/review" },
    { from: ".claude/skills", to: "$GSTACK_ROOT" },
    { from: "CLAUDE.md", to: "AGENTS.md" },
  ],
  suppressedResolvers: [],
});
ALL_HOST_CONFIGS.push(ling);
HOST_CONFIG_MAP.ling = ling;
const { runGeneration } = await fromSource("scripts/gen-skill-docs.ts");
await mkdir(output, { recursive: true });
const result = await runGeneration({ host: "ling", model: "gpt", outputRoot: output, contentLinkRoot: null, respectDetection: false });
for (const diagnostic of result.diagnostics) {
  if (diagnostic.kind === "error" || diagnostic.kind === "stale") process.stderr.write(`${diagnostic.kind}: ${diagnostic.message}\n`);
}
if (result.exitCode) throw new Error("Upstream generation failed");
process.stdout.write(`${JSON.stringify({ artifacts: result.artifacts, diagnostics: result.diagnostics })}\n`);
