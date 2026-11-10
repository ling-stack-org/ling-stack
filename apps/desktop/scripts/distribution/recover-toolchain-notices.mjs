#!/usr/bin/env node
/** Refresh immutable upstream tool notices; does not certify binary provenance. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const gitBlob = value => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const inputs = [
  { name: "Node.js", version: "v22.22.1", repository: "nodejs/node", revision: "b4acf0c9393e4b31c4937564f059c672967161d8", paths: ["LICENSE"] },
  { name: "Node.js", version: "v24.15.0", repository: "nodejs/node", revision: "848430679556aed0bd073f2bc263331ad84fa119", paths: ["LICENSE"] },
  { name: "Bun", version: "1.4.4", repository: "oven-sh/bun", revision: "38afee6c84fcf48c0edb2466aa4b27d287a59c30", paths: ["LICENSE.md", "docs/project/license.mdx", "scripts/build/deps/webkit.ts"] },
  { name: "Bun patched JavaScriptCore/WebKit", version: "d6375c72affe0f70222cdcb45012b10f0bf3a9d5", repository: "oven-sh/WebKit", revision: "d6375c72affe0f70222cdcb45012b10f0bf3a9d5", paths: ["Source/JavaScriptCore/COPYING.LIB", "Source/WTF/LICENSE-LLVM.txt", "Source/WTF/LICENSE-dragonbox.txt", "Source/WTF/LICENSE-libc++.txt", "Source/WTF/LICENSE-simde.txt"] },
];
const entries = [];
for (const input of inputs) {
  const files = [];
  for (const path of input.paths) {
    const url = `https://raw.githubusercontent.com/${input.repository}/${input.revision}/${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`toolchain_notice_http_${response.status}:${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    files.push({ path, url, sizeBytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlob(bytes), contentBase64: bytes.toString("base64") });
  }
  entries.push({ ...input, paths: undefined, sourceArchive: `https://github.com/${input.repository}/archive/${input.revision}.tar.gz`, files });
}
writeFileSync(new URL("./vendor-notices/toolchain-sources.json", import.meta.url), JSON.stringify({ schemaVersion: 1, kind: "exact-upstream-toolchain-notices", scope: "Original upstream files from exact release source revisions, including source/relink directions. Runtime version and binary digests are bound separately; this record does not assert that a local runtime binary was downloaded from an official distribution.", entries }, null, 2) + "\n");
process.stdout.write(JSON.stringify(entries.map(({ name, version, revision, files }) => ({ name, version, revision, files: files.length })), null, 2) + "\n");
