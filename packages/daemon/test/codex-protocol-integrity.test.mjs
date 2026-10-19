import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../src/runtime/adapters/codex/protocol/", import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");

test("native Codex types preserve the pinned upstream closure and attribution", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(manifest.revision, "16ff14c266179e6a762dc8081e9dab73a96683e0");
  assert.equal(manifest.repository, "https://github.com/openai/codex");
  assert.equal(manifest.license, "Apache-2.0");
  for (const name of ["InitializeResponse.ts", "v2/ThreadResumeResponse.ts", "v2/TurnStartParams.ts",
    "v2/CommandExecutionRequestApprovalParams.ts", "v2/PermissionsRequestApprovalResponse.ts", "v2/DynamicToolCallParams.ts",
    "v2/FileChangePatchUpdatedNotification.ts"]) {
    assert.ok(manifest.roots.includes(name), name);
  }
  const { parse } = await import("@babel/parser");
  for (const [name, entry] of Object.entries(manifest.files)) {
    assert.ok(!name.startsWith("../") && name.endsWith(".ts"));
    const local = await readFile(new URL(name, root), "utf8");
    assert.equal(hash(local), entry.localSha256, name);
    const ast = parse(local, { sourceType: "module", plugins: ["typescript"] });
    let original = local;
    for (const statement of ast.program.body.toReversed()) {
      if (statement.type !== "ImportDeclaration") continue;
      const specifier = statement.source;
      assert.ok(specifier.value.endsWith(".js"));
      const dependency = new URL(specifier.value.replace(/\.js$/, ".ts"), new URL(name, root));
      assert.ok(manifest.files[decodeURI(dependency.href.slice(root.href.length))], name);
      original = original.slice(0, specifier.start) + JSON.stringify(specifier.value.slice(0, -3)) + original.slice(specifier.end);
    }
    assert.equal(hash(original), entry.upstreamSha256, `${name}: declarations must remain unchanged`);
  }
  const files = (await readdir(root, { recursive: true })).filter(name => name.endsWith(".ts")).sort();
  assert.deepEqual(files, Object.keys(manifest.files).sort());
  assert.match(await readFile(new URL("LICENSE", root), "utf8"), /Apache License/);
  assert.match(await readFile(new URL("NOTICE", root), "utf8"), /OpenAI/);
});
