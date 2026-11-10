import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const inputs = [
  ["image-size", "1.2.1", "dist/types/icns.js", "5e6a097fca237b0bb3b68a1be920e39a3846c0018d8917658b5ed88590a710e8", "icns"],
  ["image-size", "1.2.1", "dist/types/utils.js", "e9faf86abcc962a5fc2488a4c3c9d8dc915aa22a0dd6a7bad6556cd9a326c349", "boxes"],
  ["html-to-docx", "1.8.0", "dist/html-to-docx.umd.js", "a29903498fd1ab6d239bf829a0c798c996e0b4dd556a289eb9c3b23b88bd3f69", "icns"],
  ["html-to-docx", "1.8.0", "dist/html-to-docx.esm.js", "4a085af69cb0261a4ed155e48fd59c15d86b348e7bd2d9da5762e62009511792", "icns"],
];
const checksum = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Backport bounded traversal without changing the pinned upstream dependency graph.
// DOCX publishes its own parser inside both distributions, independent of node_modules.
export async function applyImageParserSecurityPatches({ runtimeRoot }) {
  const root = await realpath(runtimeRoot);
  const require = createRequire(join(root, "package.json"));
  const changes = [];
  for (const [name, version, file, expected, kind] of inputs) {
    const packageRoot = await realpath(dirname(require.resolve(`${name}/package.json`)));
    const path = await realpath(join(packageRoot, file));
    const location = relative(root, path);
    if (isAbsolute(location) || location === ".." || location.startsWith("../") || location.startsWith("..\\")) {
      throw new Error("gstack_image_dependency_escape");
    }
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const before = await readFile(path);
    if (metadata.version !== version || checksum(before) !== `sha256:${expected}`) {
      throw new Error(`gstack_image_input_changed_review_patch:${name}/${file}`);
    }
    const after = transform(before.toString("utf8"), kind);
    changes.push({ path, location: location.split("\\").join("/"), before, after, name, version, kind });
  }
  const patchPath = "patches/ling-image-parser-backports.mjs";
  await mkdir(join(root, "patches"), { recursive: true });
  await copyFile(fileURLToPath(import.meta.url), join(root, patchPath));
  const patchChecksum = checksum(await readFile(join(root, patchPath)));
  const records = [];
  for (const change of changes) {
    await writeFile(change.path, change.after);
    records.push({
      package: change.name, version: change.version,
      advisory: change.kind === "icns" ? "GHSA-w3rx-r6r6-pgpr" : "GHSA-5p2g-fcmc-qvqq",
      path: change.location, beforeChecksum: checksum(change.before), afterChecksum: checksum(Buffer.from(change.after)),
      patchPath, patchChecksum,
    });
  }
  return records;
}

function transform(source, kind) {
  const comments = [];
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", onComment: comments });
  const matches = [];
  const nodes = [ast];
  while (nodes.length) {
    const node = nodes.pop();
    if (kind === "icns" && node.type === "AssignmentExpression" &&
      node.left.type === "MemberExpression" && !node.left.computed &&
      node.left.object.name === "exports" && node.left.property.name === "ICNS" && node.right.type === "ObjectExpression") {
      const property = node.right.properties.find(p => !p.computed && p.key.name === "calculate");
      if (property?.value.type === "FunctionExpression" && property.value.params.length === 1 &&
        property.value.params[0].type === "Identifier") {
        matches.push({ body: property.value.body, replacement: icnsBody(property.value.params[0].name) });
      }
    }
    if (kind === "boxes" && node.type === "FunctionDeclaration" && node.id.name === "readBox" &&
      node.params.length === 2 && node.params.every(p => p.type === "Identifier")) {
      matches.push({ body: node.body, replacement: boxBody(...node.params.map(p => p.name)) });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value.filter(n => n && typeof n.type === "string"));
      else if (value && typeof value.type === "string") nodes.push(value);
    }
  }
  if (matches.length !== 1) throw new Error("gstack_image_patch_structure_changed");
  const edits = matches.map(({ body, replacement }) => ({ start: body.start, end: body.end, text: replacement }));
  // Original source maps no longer describe transformed offsets; never advertise them.
  edits.push(...comments.filter(c => c.value.trim().startsWith("# sourceMappingURL=")).map(c => ({ start: c.start, end: c.end, text: "" })));
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  parse(source, { ecmaVersion: "latest", sourceType: "module" });
  return source;
}

function icnsBody(input) {
  return `{
    if (${input}.length < 8) throw new TypeError('Invalid ICNS file length');
    const read32 = offset => ${input}[offset] * 2 ** 24 + ${input}[offset + 1] * 2 ** 16 + ${input}[offset + 2] * 2 ** 8 + ${input}[offset + 3];
    const maxLength = Math.min(read32(4), ${input}.length);
    if (maxLength < 8) throw new TypeError('Invalid ICNS file length');
    const images = [];
    let offset = 8;
    while (offset < maxLength) {
      if (offset + 8 > maxLength) throw new TypeError('Invalid ICNS image entry header');
      const length = read32(offset + 4);
      if (length < 8 || offset + length > maxLength) throw new TypeError('Invalid ICNS image entry length');
      const type = String.fromCharCode(...${input}.slice(offset, offset + 4));
      images.push(getImageSize(type));
      offset += length;
    }
    if (!images.length) throw new TypeError('Invalid ICNS, no size found');
    if (images.length === 1) return images[0];
    return { width: images[0].width, height: images[0].height, images };
  }`;
}

function boxBody(input, offset) {
  return `{
    if (!Number.isSafeInteger(${offset}) || ${offset} < 0 || ${input}.length - ${offset} < 8) return;
    const size = (0, exports.readUInt32BE)(${input}, ${offset});
    if (size < 8 || size > ${input}.length - ${offset}) return;
    return { name: (0, exports.toUTF8String)(${input}, ${offset} + 4, ${offset} + 8), offset: ${offset}, size };
  }`;
}
