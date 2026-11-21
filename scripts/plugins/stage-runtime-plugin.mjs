#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const kind = args.kind;
const output = resolve(args.output ?? `.tmp/plugin-${kind}`);
if (!kind || !["chrome-browser", "office-documents"].includes(kind)) throw new Error("--kind must be chrome-browser or office-documents.");
const source = resolve(`plugins/official/${kind}`);
await rm(output, { recursive: true, force: true });
await mkdir(join(output, ".ling-plugin"), { recursive: true });
await cp(join(source, ".ling-plugin/plugin.json"), join(output, ".ling-plugin/plugin.json"));
await cp(join(source, "mcp-server.json"), join(output, "mcp-server.json"));
await cp(join(source, "README.md"), join(output, "README.md"));
const resources = kind === "chrome-browser"
  ? [
      [args.extension ?? "apps/chrome-extension/ling-for-chrome.zip", "ling-for-chrome.zip"],
      [args.host, `ling-browser-host${args.platform === "win32" ? ".exe" : ""}`],
    ]
  : [[args.helper ?? "apps/desktop/dist/office-driver/ling-office-driver", "ling-office-driver"]];
for (const [from, to] of resources) {
  if (!from) throw new Error(`Missing runtime resource for ${kind}: ${to}`);
  await cp(resolve(from), join(output, to));
}
console.log(JSON.stringify({ kind, output, manifest: JSON.parse(await readFile(join(output, ".ling-plugin/plugin.json"), "utf8")) }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return result;
}
