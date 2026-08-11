import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { ts, visitTypeScriptNode, withTypeScriptSourceFiles } from "./typescript-ast.mjs";

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

const selfTestDir = mkdtempSync(join(tmpdir(), "ling-browser-dialog-guard-"));
const selfTestFile = join(selfTestDir, "browser-dialog-guard-self-test.ts");
writeFileSync(selfTestFile, [
  "window.alert('blocked');",
  "globalThis.confirm('blocked');",
  "window['prompt']('blocked');",
  "function confirm() { return true; }",
  "confirm();",
].join("\n"));

const productionFiles = sourceRoots.flatMap((root) => collectSourceFiles(root));
let violations;
try {
  violations = withTypeScriptSourceFiles([...productionFiles, selfTestFile], (sourceFiles) => {
    const selfTest = findViolations(sourceFiles.get(resolve(selfTestFile)), "browser-dialog-guard-self-test.ts");
    if (selfTest.length !== 3) {
      throw new Error(`Browser dialog guard self-test failed: expected 3 violations, found ${selfTest.length}.`);
    }
    return productionFiles.flatMap((file) => (
      findViolations(sourceFiles.get(resolve(file)), relative(repoRoot, file))
    ));
  });
} finally {
  rmSync(selfTestDir, { recursive: true, force: true });
}

if (!violations) {
  throw new Error("Browser dialog guard produced no result.");
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
  visitTypeScriptNode(sourceFile, (node) => {
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
    const method = argument && ts.isStringLiteral(argument) ? argument.text : "";
    return browserGlobals.has(global) && blockedMethods.has(method) ? { global, method } : undefined;
  }
  return undefined;
}
