import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(packageRoot, "../..");
export const catalogRoot = path.join(packageRoot, "catalogs");

export function readCatalog(locale) {
  const file = path.join(catalogRoot, `${locale}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !parsed
    || parsed.locale !== locale
    || typeof parsed.sourceRevision !== "string"
    || !isStringRecord(parsed.messages)
    || (parsed.sourceHashes !== undefined && !isStringRecord(parsed.sourceHashes))
  ) {
    throw new Error(`Invalid catalog: ${path.relative(repoRoot, file)}`);
  }
  return parsed;
}

export function writeCatalog(locale, sourceRevision, messages, sourceMessages = messages) {
  fs.mkdirSync(catalogRoot, { recursive: true });
  const file = path.join(catalogRoot, `${locale}.json`);
  const sorted = Object.fromEntries(Object.entries(messages).sort(([left], [right]) => left.localeCompare(right)));
  const sourceHashes = Object.fromEntries(
    Object.keys(sorted).map((key) => [key, messageSourceHash(sourceMessages[key] ?? key)]),
  );
  const value = { locale, sourceRevision, sourceHashes, messages: sorted };
  const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporaryFile, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporaryFile, file);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

export function sourceRevision(messages) {
  const stable = JSON.stringify(Object.fromEntries(Object.entries(messages).sort(([left], [right]) => left.localeCompare(right))));
  return createHash("sha256").update(stable).digest("hex");
}

export function messageSourceHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
}

export function isStringRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) continue;
    const [rawKey, inlineValue] = current.slice(2).split("=", 2);
    const next = inlineValue ?? (argv[index + 1]?.startsWith("--") ? "true" : argv[++index] ?? "true");
    values.set(rawKey, next);
  }
  return values;
}
