import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const webRoot = process.cwd();
const repoRoot = resolve(webRoot, "../..");
const sourceRoots = [
  resolve(repoRoot, "apps/web/src"),
  resolve(repoRoot, "packages/ui-react/src"),
  resolve(repoRoot, "packages/conversation-ui-core/src"),
  resolve(repoRoot, "packages/conversation-ui-react/src"),
];
const blockedMethods = new Set(["alert", "confirm", "prompt"]);
const browserGlobals = new Set(["globalThis", "window"]);

const selfTest = findViolations(
  ts.createSourceFile(
    "browser-dialog-guard-self-test.ts",
    [
      "window.alert('blocked');",
      "globalThis.confirm('blocked');",
      "window['prompt']('blocked');",
      "function confirm() { return true; }",
      "confirm();",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  ),
  "browser-dialog-guard-self-test.ts",
);
if (selfTest.length !== 3) {
  console.error(`Browser dialog guard self-test failed: expected 3 violations, found ${selfTest.length}.`);
  process.exit(1);
}

const violations = [];
for (const root of sourceRoots) {
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      sourceKind(file),
    );
    violations.push(...findViolations(sourceFile, relative(repoRoot, file)));
  }
}

if (violations.length > 0) {
  console.error("Use shared Dialog/Toast feedback instead of blocking browser dialogs:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("browser blocking dialog contract: window/globalThis alert|confirm|prompt=0");

function collectSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(file));
    } else if (entry.isFile() && [".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extname(entry.name))) {
      files.push(file);
    }
  }
  return files;
}

function findViolations(sourceFile, displayPath) {
  const found = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const target = readBrowserDialogTarget(node.expression);
    if (!target) return;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    found.push(`${displayPath}:${line} ${target.global}.${target.method}()`);
  });
  return found;
}

function readBrowserDialogTarget(expression) {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const global = expression.expression.text;
    const method = expression.name.text;
    return browserGlobals.has(global) && blockedMethods.has(method) ? { global, method } : undefined;
  }
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const global = expression.expression.text;
    const argument = expression.argumentExpression;
    const method = argument && ts.isStringLiteralLike(argument) ? argument.text : "";
    return browserGlobals.has(global) && blockedMethods.has(method) ? { global, method } : undefined;
  }
  return undefined;
}

function sourceKind(file) {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
