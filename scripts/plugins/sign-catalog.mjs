#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { sign } from "node:crypto";
import { resolve } from "node:path";
import { requireOfficialSigningKey } from "./official-signing-key.mjs";

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input ?? "plugins/catalog.json");
const output = resolve(args.output ?? "plugins/catalog.sig");
const keyText = process.env.LING_PLUGIN_CATALOG_PRIVATE_KEY
  ?? (args.privateKey ? await readFile(resolve(args.privateKey), "utf8") : undefined);
if (!keyText?.trim()) throw new Error("LING_PLUGIN_CATALOG_PRIVATE_KEY or --privateKey is required.");
let key = keyText.trim();
if (args.official) {
  const { OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY } = await import("../../packages/core/dist/official-plugin-runtime.js");
  key = requireOfficialSigningKey(keyText, OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY, "LING_PLUGIN_CATALOG_PRIVATE_KEY");
}
const bytes = await readFile(input);
const signature = sign(null, bytes, key);
await writeFile(output, `ed25519:${signature.toString("base64")}\n`);
console.log(JSON.stringify({ input, output, algorithm: "ed25519" }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result[argv[index].slice(2)] = argv[index + 1]?.startsWith("--") ? true : argv[++index];
  }
  return result;
}
