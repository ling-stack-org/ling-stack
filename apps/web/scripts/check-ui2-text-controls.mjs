import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const webRoot = process.cwd();
const sourceRoot = resolve(webRoot, "src");
const decisionGatedControls = new Map([
  ["features/workspace/ChannelWorkThreadTree.tsx", { tag: "input", type: "search" }],
]);
const nativeInputTypes = new Set(["checkbox", "file", "range"]);
const violations = [];
const retained = [];
const ownedNativeControls = [];

for (const file of collectTsxFiles(sourceRoot)) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const sourcePath = relative(sourceRoot, file);
  visit(sourceFile, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const tag = node.tagName.getText(sourceFile);
    if (tag !== "input" && tag !== "textarea") return;
    const type = tag === "textarea" ? "textarea" : readStaticInputType(node, sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    if (tag === "input" && type && nativeInputTypes.has(type)) {
      if (readStaticAttribute(node, sourceFile, "data-ling-control-native") !== "true") {
        violations.push(`${sourcePath}:${line} <input type="${type}"> missing data-ling-control-native="true"`);
      } else {
        ownedNativeControls.push(`${sourcePath}:${line} <input type="${type}">`);
      }
      return;
    }

    const allowed = decisionGatedControls.get(sourcePath);
    if (allowed?.tag === tag && allowed.type === type) {
      retained.push(`${sourcePath}:${line} <${tag} type="${type}">`);
      return;
    }
    violations.push(`${sourcePath}:${line} <${tag}${type ? ` type="${type}"` : " dynamic-type"}>`);
  });
}

for (const sourcePath of decisionGatedControls.keys()) {
  if (!retained.some((entry) => entry.startsWith(`${sourcePath}:`))) {
    violations.push(`${sourcePath} decision-gated raw control contract is missing`);
  }
}

if (violations.length > 0) {
  console.error("Use shared Input/Textarea for production text controls and mark owned native controls:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`UI 2.0 raw controls: text reachable=0, decision-gated=${retained.length}/${decisionGatedControls.size}, native-owned=${ownedNativeControls.length}`);

function collectTsxFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectTsxFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".tsx")) files.push(file);
  }
  return files;
}

function readStaticInputType(node, sourceFile) {
  return readStaticAttribute(node, sourceFile, "type") ?? "text";
}

function readStaticAttribute(node, sourceFile, name) {
  const attribute = node.attributes.properties.find((property) => (
    ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name
  ));
  if (!attribute) return undefined;
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return "true";
  return ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : "dynamic";
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
