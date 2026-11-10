import fs from "node:fs";
import path from "node:path";

import { catalogRoot, repoRoot } from "./catalog-utils.mjs";
import { ts, withTypeScriptSourceFiles } from "../../../apps/web/scripts/typescript-ast.mjs";

/**
 * Parse the Web en-US/zh-CN dictionary exports plus the additional JSON sources.
 * Shared by the legacy importer and the Chinese draft filler so both see the
 * exact same key universe.
 */
export function readWebLocaleSources({ localeRoot, additionalRoot } = {}) {
  localeRoot ??= path.join(repoRoot, "apps/web/src/i18n/locales");
  const readAdditional = (fileName) => readAdditionalMessages(fileName, additionalRoot ?? catalogRoot);
  const englishFile = path.join(localeRoot, "en-US.ts");
  const chineseFile = path.join(localeRoot, "zh-CN.ts");
  const { english, chinese } = withTypeScriptSourceFiles(
    [englishFile, chineseFile],
    (sourceFiles) => ({
      english: parseDictionary(englishFile, "enUS", sourceFiles.get(path.resolve(englishFile))),
      chinese: parseDictionary(chineseFile, "zhCN", sourceFiles.get(path.resolve(chineseFile))),
    }),
    { cwd: path.join(repoRoot, "apps/web"), configFile: path.join(repoRoot, "apps/web/tsconfig.json") },
  );
  return {
    english, chinese, englishFile, chineseFile,
    additionalEnglish: readAdditional("additional-source.json"),
    additionalChinese: readAdditional("additional-zh-CN.json"),
  };
}

export function readAdditionalMessages(fileName, root = catalogRoot) {
  const file = path.join(root, fileName);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`Invalid additional catalog source: ${file}`);
  }
  return parsed;
}

function parseDictionary(file, exportName, sourceFile) {
  if (!sourceFile) throw new Error(`TypeScript could not load ${file}`);
  const output = {};
  let found = false;

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === exportName && node.initializer) {
      const object = unwrap(node.initializer);
      if (!ts.isObjectLiteralExpression(object)) {
        throw new Error(`${exportName} must be an object literal`);
      }
      found = true;
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name);
        const value = stringValue(property.initializer);
        if (key === undefined || value === undefined) {
          throw new Error(`Unsupported catalog entry at ${file}:${sourceFile.getLineAndCharacterOfPosition(property.getStart()).line + 1}`);
        }
        if (Object.hasOwn(output, key)) {
          throw new Error(`Duplicate catalog key in ${file}: ${key}`);
        }
        output[key] = value;
      }
    }
    ts.visitEachChild(node, (child) => {
      visit(child);
      return child;
    });
  }

  visit(sourceFile);
  if (!found) throw new Error(`Could not find ${exportName} in ${file}`);
  return output;
}

function unwrap(node) {
  let current = node;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function propertyName(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isIdentifier(node)
    ? node.text
    : undefined;
}

function stringValue(node) {
  const value = unwrap(node);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}
