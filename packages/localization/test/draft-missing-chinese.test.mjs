import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/draft-missing-chinese.mjs");

function fixture(t, { english, chinese, additionalEnglish = {}, additionalChinese = {} }) {
  const root = mkdtempSync(join(tmpdir(), "ling-zh-draft-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localeRoot = join(root, "locales");
  const additionalRoot = join(root, "additional");
  mkdirSync(localeRoot, { recursive: true });
  mkdirSync(additionalRoot, { recursive: true });
  const toTs = (name, dictionary) => `export const ${name} = {\n${Object.entries(dictionary)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n")}\n} as const satisfies Readonly<Record<string, string>>;\n`;
  writeFileSync(join(localeRoot, "en-US.ts"), toTs("enUS", english));
  writeFileSync(join(localeRoot, "zh-CN.ts"), toTs("zhCN", chinese));
  writeFileSync(join(additionalRoot, "additional-source.json"), JSON.stringify(additionalEnglish));
  writeFileSync(join(additionalRoot, "additional-zh-CN.json"), JSON.stringify(additionalChinese));
  return { localeRoot, additionalRoot };
}

function run(fixturePaths, translations = {}) {
  return spawnSync(process.execPath, [script,
    "--locale-root", fixturePaths.localeRoot, "--additional-root", fixturePaths.additionalRoot,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      LING_DRAFT_TRANSLATE_STUB: Buffer.from(JSON.stringify(translations)).toString("base64"),
    },
  });
}

test("no missing keys is a no-op with an empty summary", (t) => {
  const paths = fixture(t, { english: { Save: "Save" }, chinese: { Save: "保存" } });
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { drafted: [] });
  assert.ok(readFileSync(join(paths.localeRoot, "zh-CN.ts"), "utf8").includes('"Save": "保存"'));
});

test("drafts missing zh-CN dictionary and additional keys into the real sources", (t) => {
  const paths = fixture(t, {
    english: { Save: "Save", "Export report": "Export report" },
    chinese: { Save: "保存" },
    additionalEnglish: { "daemon.extra": "daemon extra" },
  });
  const result = run(paths, { "Export report": "导出报告", "daemon extra": "守护进程额外项" });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.deepEqual(summary.drafted.sort(), ["Export report", "daemon.extra"]);
  const zh = readFileSync(join(paths.localeRoot, "zh-CN.ts"), "utf8");
  assert.ok(zh.includes('"Export report": "导出报告"'), zh);
  assert.ok(zh.includes("} as const satisfies"), zh);
  const additional = JSON.parse(readFileSync(join(paths.additionalRoot, "additional-zh-CN.json"), "utf8"));
  assert.equal(additional["daemon.extra"], "守护进程额外项");
});

test("a second run after drafting is a no-op", (t) => {
  const paths = fixture(t, { english: { Export: "Export" }, chinese: {} });
  const first = run(paths, { Export: "导出" });
  assert.equal(first.status, 0, first.stderr);
  const second = run(paths);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim().split("\n").at(-1)), { drafted: [] });
});

test("fails closed when a draft loses placeholders or comes back empty", (t) => {
  const paths = fixture(t, { english: { "Delete {name}": "Delete {name}" }, chinese: {} });
  const empty = run(paths, { "Delete {name}": "" });
  assert.notEqual(empty.status, 0);
  const broken = run(paths, { "Delete {name}": "删除" });
  assert.notEqual(broken.status, 0);
  assert.ok(readFileSync(join(paths.localeRoot, "zh-CN.ts"), "utf8").includes("} as const satisfies"));
});
