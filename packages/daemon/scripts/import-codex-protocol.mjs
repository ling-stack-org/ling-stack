import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const revision = "16ff14c266179e6a762dc8081e9dab73a96683e0";
const sourceRoot = process.argv[2];
if (!sourceRoot || !isAbsolute(sourceRoot) || process.argv.length !== 3) throw new Error("codex_schema_source_required");
const sourceTypes = resolve(sourceRoot, "codex-rs/app-server-protocol/schema/typescript");
const destination = resolve(dirname(fileURLToPath(import.meta.url)), "../src/runtime/adapters/codex/protocol");
const roots = ["InitializeParams", "InitializeResponse", ...[
  "ThreadStartParams", "ThreadStartResponse", "ThreadResumeParams", "ThreadResumeResponse", "ThreadReadParams", "ThreadReadResponse",
  "TurnStartParams", "TurnStartResponse", "TurnInterruptParams", "TurnInterruptResponse", "TurnStartedNotification", "TurnCompletedNotification",
  "AgentMessageDeltaNotification", "ItemStartedNotification", "ItemCompletedNotification", "CommandExecutionOutputDeltaNotification",
  "CommandExecutionRequestApprovalParams", "CommandExecutionRequestApprovalResponse", "FileChangeRequestApprovalParams", "FileChangeRequestApprovalResponse",
  "PermissionsRequestApprovalParams", "PermissionsRequestApprovalResponse", "ToolRequestUserInputParams", "ToolRequestUserInputResponse",
  "ReasoningTextDeltaNotification", "ReasoningSummaryTextDeltaNotification", "ErrorNotification", "DynamicToolCallParams", "DynamicToolCallResponse",
  "ServerRequestResolvedNotification", "ModelReroutedNotification",
  "FileChangePatchUpdatedNotification",
].map(name => `v2/${name}`)].map(name => `${name}.ts`);
const queue = [...roots];
const files = new Map();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
while (queue.length) {
  const name = queue.shift();
  if (files.has(name)) continue;
  if (name.startsWith("../") || !name.endsWith(".ts")) throw new Error("codex_schema_import_invalid");
  const source = await readFile(resolve(sourceTypes, name), "utf8");
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const changes = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const specifier = statement.source;
    if (!specifier.value.startsWith(".")) throw new Error("codex_schema_import_invalid");
    const dependency = posix.normalize(posix.join(posix.dirname(name), specifier.value + ".ts"));
    queue.push(dependency);
    changes.push({ start: specifier.start, end: specifier.end, value: JSON.stringify(`${specifier.value}.js`) });
  }
  let generated = source;
  for (const change of changes.reverse()) generated = generated.slice(0, change.start) + change.value + generated.slice(change.end);
  files.set(name, { source, generated });
}
await mkdir(destination, { recursive: true });
for (const [name, { generated }] of files) {
  const path = resolve(destination, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, generated);
}
await writeFile(resolve(destination, "LICENSE"), await readFile(resolve(sourceRoot, "LICENSE")));
await writeFile(resolve(destination, "NOTICE"), await readFile(resolve(sourceRoot, "NOTICE")));
const manifest = { repository: "https://github.com/openai/codex", revision, license: "Apache-2.0",
  transform: "TypeScript AST module specifiers gain .js for NodeNext; declarations unchanged", roots,
  files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, value]) =>
    [name, { upstreamSha256: hash(value.source), localSha256: hash(value.generated) }])) };
await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ files: files.size, revision, destination })}\n`);
