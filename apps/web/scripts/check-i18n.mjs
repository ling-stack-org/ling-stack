import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "./typescript-ast.mjs";

const webRoot = process.cwd();
const srcRoot = path.join(webRoot, "src");
const localeFiles = {
  "en-US": { file: path.join(srcRoot, "i18n/locales/en-US.ts"), exportName: "enUS" },
  "zh-CN": { file: path.join(srcRoot, "i18n/locales/zh-CN.ts"), exportName: "zhCN" },
};

function propertyName(node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  return undefined;
}

function unwrapExpression(expression) {
  let current = expression;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))) {
    current = current.expression;
  }
  return current;
}

function parseLocale({ file, exportName }, sourceFile) {
  const keys = new Set();
  const duplicates = [];

  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === exportName && node.initializer) {
      const objectExpression = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(objectExpression)) {
        for (const property of objectExpression.properties) {
          if (!ts.isPropertyAssignment(property)) {
            continue;
          }
          const key = propertyName(property.name);
          if (!key) {
            continue;
          }
          if (keys.has(key)) {
            duplicates.push(key);
          }
          keys.add(key);
        }
      }
    }
    ts.visitEachChild(node, (child) => {
      visit(child);
      return child;
    });
  }

  visit(sourceFile);
  return { keys, duplicates };
}

function collectSourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".next", "test-results", "playwright-report"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectLiteralTranslationKeys(files, sourceFiles) {
  const keys = new Set();
  const dynamicCalls = [];
  for (const file of files) {
    const sourceFile = sourceFiles.get(path.resolve(file));
    visitTypeScriptNode(sourceFile, (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "t") {
        const argument = node.arguments[0];
        if (argument) {
          if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
            keys.add(argument.text);
          } else {
            const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
            dynamicCalls.push(`${path.relative(webRoot, file)}:${position.line + 1}`);
          }
        }
      }
    });
  }
  return { keys, dynamicCalls };
}

const allSourceFiles = collectSourceFiles(srcRoot);
const audit = withTypeScriptSourceFiles(allSourceFiles, (sourceFiles) => ({
  english: parseLocale(localeFiles["en-US"], sourceFiles.get(path.resolve(localeFiles["en-US"].file))),
  chinese: parseLocale(localeFiles["zh-CN"], sourceFiles.get(path.resolve(localeFiles["zh-CN"].file))),
  literalTranslations: collectLiteralTranslationKeys(allSourceFiles, sourceFiles),
}));
const { english, chinese, literalTranslations } = audit;
const missingChinese = [...literalTranslations.keys].filter((key) => !chinese.keys.has(key));
const englishOnlyKeys = [...english.keys].filter((key) => !chinese.keys.has(key));
const failures = [];

if (english.duplicates.length > 0) {
  failures.push(`en-US has duplicate keys: ${english.duplicates.slice(0, 20).join(", ")}`);
}
if (chinese.duplicates.length > 0) {
  failures.push(`zh-CN has duplicate keys: ${chinese.duplicates.slice(0, 20).join(", ")}`);
}
if (missingChinese.length > 0) {
  failures.push(`zh-CN is missing literal translation keys: ${missingChinese.slice(0, 40).join(", ")}`);
}
if (englishOnlyKeys.length > 0) {
  failures.push(`en-US has keys missing from zh-CN: ${englishOnlyKeys.slice(0, 40).join(", ")}`);
}

console.log(`i18n audit: en-US=${english.keys.size}, zh-CN=${chinese.keys.size}, literalKeys=${literalTranslations.keys.size}, dynamicCalls=${literalTranslations.dynamicCalls.length}`);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
