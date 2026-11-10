import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractFile, listPackage } from "@electron/asar";

import { SUPPORTED_CATALOG_LOCALES } from "../../../packages/localization/scripts/catalog-locales.mjs";
import { computeAppBundleTreeSha256 } from "./verify-macos-signed-candidate.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const defaultApp = join(repositoryRoot, "apps/desktop/release/mac-arm64/Ling Stack.app");
const defaultOutput = join(
  repositoryRoot,
  "apps/desktop/test-results/packaged-language-parity/package-verifier.json",
);
const localizationPackageRoot = join(repositoryRoot, "packages/localization");
const localizationAsarRoot = "node_modules/@ling-stack/localization";
const expectedLocales = Object.freeze([...SUPPORTED_CATALOG_LOCALES]);

function parseArguments(argv) {
  const options = { app: defaultApp, output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split("=", 2);
    if (name !== "--app" && name !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    options[name.slice(2)] = resolve(value);
  }
  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactOrderedValues(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} mismatch: expected ${expected.join(", ")}; received ${actual.join(", ")}`,
  );
}

function assertExactSet(actual, expected, label) {
  const actualSorted = [...new Set(actual)].sort();
  const expectedSorted = [...new Set(expected)].sort();
  assertExactOrderedValues(actualSorted, expectedSorted, label);
  assert(actual.length === actualSorted.length, `${label} contains duplicate entries`);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function extractAsarText(asarPath, path) {
  try {
    return extractFile(asarPath, path).toString("utf8");
  } catch (error) {
    throw new Error(
      `Unable to read ${path} from app.asar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseCompiledCatalog(source, label) {
  const match = source.match(/^export const catalog = ([\s\S]+);\s*$/u);
  assert(match?.[1], `${label} is not a generated localization catalog`);
  const catalog = JSON.parse(match[1]);
  assert(
    catalog && typeof catalog.locale === "string" && typeof catalog.sourceRevision === "string",
    `${label} has invalid catalog metadata`,
  );
  assert(
    catalog.messages && typeof catalog.messages === "object" && !Array.isArray(catalog.messages),
    `${label} has invalid catalog messages`,
  );
  return catalog;
}

async function readPackagedRegistry(source) {
  const sourceUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = await import(sourceUrl);
  assert(Array.isArray(module.SUPPORTED_LOCALES), "Packaged locale registry has no SUPPORTED_LOCALES array");
  return module.SUPPORTED_LOCALES;
}

function readGitValue(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function webChunkContainsCatalog(source, locale, sourceRevision) {
  const escapedLocale = locale.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return source.includes(sourceRevision)
    && new RegExp(`locale:[\\s]*[\\u0060\"']${escapedLocale}[\\u0060\"']`, "u").test(source);
}

async function verifyPackagedLanguageParity(options) {
  assert(expectedLocales.length === 55, `Language contract must contain exactly 55 locales, found ${expectedLocales.length}`);

  const appPath = resolve(options.app);
  const resourcesPath = join(appPath, "Contents", "Resources");
  const asarPath = join(resourcesPath, "app.asar");
  const webAssetsPath = join(resourcesPath, "web", "assets");
  const sourceCatalogPath = join(localizationPackageRoot, "catalogs");
  const sourceRegistryPath = join(localizationPackageRoot, "dist", "locale-registry.js");
  const sourceLoaderPath = join(localizationPackageRoot, "dist", "generated", "catalog-loaders.js");

  const packageEntries = listPackage(asarPath).map((entry) => entry.replace(/^\//u, ""));
  const compiledCatalogPrefix = `${localizationAsarRoot}/dist/generated/catalogs/`;
  const packagedCatalogLocales = packageEntries
    .filter((entry) => entry.startsWith(compiledCatalogPrefix) && entry.endsWith(".js"))
    .map((entry) => entry.slice(compiledCatalogPrefix.length, -3));
  assertExactSet(packagedCatalogLocales, expectedLocales, "Packaged compiled catalogs");

  const sourceCatalogLocales = (await readdir(sourceCatalogPath))
    .filter((name) => name.endsWith(".json") && !name.startsWith("additional-"))
    .map((name) => name.slice(0, -5));
  assertExactSet(sourceCatalogLocales, expectedLocales, "Source catalogs");

  const packagedRegistryPath = `${localizationAsarRoot}/dist/locale-registry.js`;
  const packagedLoaderPath = `${localizationAsarRoot}/dist/generated/catalog-loaders.js`;
  const packagedRegistrySource = extractAsarText(asarPath, packagedRegistryPath);
  const packagedLoaderSource = extractAsarText(asarPath, packagedLoaderPath);
  const packagedRegistryLocales = await readPackagedRegistry(packagedRegistrySource);
  assertExactOrderedValues(packagedRegistryLocales, expectedLocales, "Packaged locale registry");

  const loaderEntries = [...packagedLoaderSource.matchAll(
    /^\s*"([^"]+)":\s*\(\)\s*=>\s*import\("\.\/catalogs\/([^"]+)\.js"\),?$/gmu,
  )];
  const loaderLocales = loaderEntries.map((match) => match[1]);
  assertExactSet(loaderLocales, expectedLocales, "Packaged catalog loader locales");
  for (const match of loaderEntries) {
    assert(match[1] === match[2], `Catalog loader ${match[1]} resolves the wrong module: ${match[2]}`);
  }

  const sourceRegistrySource = await readFile(sourceRegistryPath, "utf8");
  const sourceLoaderSource = await readFile(sourceLoaderPath, "utf8");
  const sourceRegistrySha256 = sha256Buffer(sourceRegistrySource);
  const packagedRegistrySha256 = sha256Buffer(packagedRegistrySource);
  assert(
    packagedRegistrySha256 === sourceRegistrySha256,
    "Packaged locale registry does not match the built source registry",
  );
  assert(
    sha256Buffer(packagedLoaderSource) === sha256Buffer(sourceLoaderSource),
    "Packaged catalog loader does not match the built source loader",
  );

  const packagedCatalogs = new Map();
  for (const locale of expectedLocales) {
    const sourceCatalog = JSON.parse(await readFile(join(sourceCatalogPath, `${locale}.json`), "utf8"));
    const packagedCatalog = parseCompiledCatalog(
      extractAsarText(asarPath, `${compiledCatalogPrefix}${locale}.js`),
      `Packaged catalog ${locale}`,
    );
    assert(sourceCatalog.locale === locale, `Source catalog ${locale} has the wrong locale metadata`);
    assert(packagedCatalog.locale === locale, `Packaged catalog ${locale} has the wrong locale metadata`);
    assert(
      JSON.stringify(packagedCatalog.messages) === JSON.stringify(sourceCatalog.messages),
      `Packaged catalog ${locale} does not match the source messages`,
    );
    assert(
      packagedCatalog.sourceRevision === sourceCatalog.sourceRevision,
      `Packaged catalog ${locale} does not match the source revision`,
    );
    packagedCatalogs.set(locale, packagedCatalog);
  }

  const englishCatalog = packagedCatalogs.get("en-US");
  assert(englishCatalog, "The required en-US fallback catalog is missing");
  const englishKeys = Object.keys(englishCatalog.messages).sort();
  const catalogSourceRevision = englishCatalog.sourceRevision;
  for (const locale of expectedLocales) {
    const catalog = packagedCatalogs.get(locale);
    assert(
      catalog.sourceRevision === catalogSourceRevision,
      `Packaged catalog ${locale} has a different source revision`,
    );
    assertExactOrderedValues(Object.keys(catalog.messages).sort(), englishKeys, `${locale} message keys`);
  }

  const webAssetNames = await readdir(webAssetsPath);
  const webCatalogChunks = {};
  for (const locale of expectedLocales) {
    const matches = webAssetNames.filter((name) => name.startsWith(`${locale}-`) && name.endsWith(".js"));
    assert(matches.length === 1, `Expected one Web catalog chunk for ${locale}, found ${matches.length}`);
    const chunkPath = join(webAssetsPath, matches[0]);
    const chunkSource = await readFile(chunkPath, "utf8");
    assert(
      webChunkContainsCatalog(chunkSource, locale, catalogSourceRevision),
      `Web catalog chunk ${matches[0]} is not bound to ${locale} at ${catalogSourceRevision}`,
    );
    webCatalogChunks[locale] = {
      file: matches[0],
      sha256: sha256Buffer(chunkSource),
    };
  }

  const sourceCommit = readGitValue(["rev-parse", "HEAD"]);
  const sourceDirty = readGitValue(["status", "--porcelain"]) !== "";
  const [appAsarSha256, appBundleTreeSha256] = await Promise.all([
    sha256File(asarPath),
    computeAppBundleTreeSha256(appPath),
  ]);

  return {
    schemaVersion: 1,
    kind: "ling-desktop-packaged-language-parity",
    generatedAt: new Date().toISOString(),
    verdict: {
      status: "PASS",
      pass: true,
      releaseCandidateBound: !sourceDirty,
      message: sourceDirty
        ? "Packaged language contents match the current worktree, but the source tree is dirty and is not a final release candidate."
        : "Packaged language contents match the clean source commit.",
    },
    source: {
      commit: sourceCommit,
      dirty: sourceDirty,
      registrySha256: sourceRegistrySha256,
      catalogSourceRevision,
      localeCount: expectedLocales.length,
      messageKeyCount: englishKeys.length,
      fallbackLocale: "en-US",
    },
    package: {
      appPath: relative(repositoryRoot, appPath),
      appAsarSha256,
      appBundleTreeSha256,
      registrySha256: packagedRegistrySha256,
      catalogLoaderSha256: sha256Buffer(packagedLoaderSource),
      compiledCatalogCount: packagedCatalogLocales.length,
      webCatalogChunkCount: Object.keys(webCatalogChunks).length,
      webCatalogChunks,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await verifyPackagedLanguageParity(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
