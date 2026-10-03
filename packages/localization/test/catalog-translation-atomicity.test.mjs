import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { messageSourceHash, sourceRevision } from "../scripts/catalog-utils.mjs";

const execute = promisify(execFile);

/** Run the real translator against disposable catalogs and a deterministic transport. */
async function translateFixture(failSecondBatch) {
  const root = await mkdtemp(path.join(tmpdir(), "ling-catalog-translation-"));
  try {
    await cp(new URL("../scripts/", import.meta.url), path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "catalogs"));
    const messages = { Alpha: "Alpha", Beta: "Beta", Reusable: "Reusable" };
    const source = { locale: "en-US", sourceRevision: sourceRevision(messages), messages };
    const destination = path.join(root, "catalogs/fr-FR.json");
    const previous = JSON.stringify({
      locale: "fr-FR", sourceRevision: "previous-revision",
      messages: { Alpha: "Ancien alpha", Beta: "Ancien beta", Reusable: "Réutilisable" },
      sourceHashes: { Alpha: "stale-alpha", Beta: "stale-beta", Reusable: messageSourceHash("Reusable") },
    });
    await writeFile(path.join(root, "catalogs/en-US.json"), JSON.stringify(source));
    await writeFile(destination, previous);
    const transport = `
      import fs from 'node:fs';
      const destination = ${JSON.stringify(destination)};
      const previous = ${JSON.stringify(previous)};
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (calls === 2) {
          if (${failSecondBatch}) throw new Error('fixture-translation-failed');
          if (fs.readFileSync(destination, 'utf8') !== previous) throw new Error('catalog-published-before-completion');
        }
        return { ok: true, json: async () => [calls === 1 ? 'Premier' : 'Deuxième'] };
      };
    `;
    let result;
    try {
      result = await execute(process.execPath, [
        `--import=data:text/javascript,${encodeURIComponent(transport)}`,
        path.join(root, "scripts/translate-catalogs.mjs"),
        "--locales=fr-FR", "--batch-size=1", "--concurrency=1", "--delay-ms=0",
      ], { timeout: 15_000 });
    } catch (error) {
      result = { code: error.code, stderr: error.stderr };
    }
    return { result, previous, source, text: await readFile(destination, "utf8"), files: await readdir(path.join(root, "catalogs")) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a later translation failure preserves the complete previous locale byte-for-byte", async () => {
  const fixture = await translateFixture(true);
  assert.equal(fixture.result.code, 1);
  assert.match(fixture.result.stderr, /fixture-translation-failed/u);
  assert.equal(fixture.text, fixture.previous);
  assert.deepEqual(fixture.files.sort(), ["en-US.json", "fr-FR.json"]);
});

test("successful translation publishes once after every batch and retains reusable translations", async () => {
  const fixture = await translateFixture(false);
  assert.equal(fixture.result.code, undefined, fixture.result.stderr);
  const catalog = JSON.parse(fixture.text);
  assert.equal(catalog.sourceRevision, fixture.source.sourceRevision);
  assert.deepEqual(catalog.messages, { Alpha: "Premier", Beta: "Deuxième", Reusable: "Réutilisable" });
  for (const [key, message] of Object.entries(fixture.source.messages)) {
    assert.equal(catalog.sourceHashes[key], messageSourceHash(message));
  }
  assert.deepEqual(fixture.files.sort(), ["en-US.json", "fr-FR.json"]);
});
