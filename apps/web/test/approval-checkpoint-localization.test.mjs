import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatCatalogMessage, loadCatalog } from "@ling-stack/localization";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(0, -3)}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { buildConversationApprovalCheckpointRows } = await import("../src/lib/conversation-work-cell.ts");
const [english, gujarati, chinese] = await Promise.all([
  loadCatalog("en-US"), loadCatalog("gu-IN"), loadCatalog("zh-CN"),
]);
const resumeKey = "Resume handle: {status}";
const catalogs = [
  { locale: "gu-IN", messages: gujarati.messages, verified: "ચકાસાયેલ", unverified: "ચકાસાયેલ નથી" },
  { locale: "en-US", messages: english.messages, verified: "verified", unverified: "unverified" },
  { locale: "zh-CN", messages: chinese.messages, verified: "已验证", unverified: "未验证" },
];

function translator(messages) {
  return (key, values) => formatCatalogMessage(messages, english.messages, key, values);
}

/** Only projection data: no Runner, Store, approval decision, or model is invoked. */
function checkpoint(overrides = {}) {
  return {
    id: "checkpoint-localization", approvalId: "approval-localization", runId: "run-localization",
    actionType: "bash", risk: "low", title: "Offline resume projection", description: "Check the displayed resume evidence",
    status: "pending", sideEffect: { type: "bash", command: "node --version" },
    previewArtifactIds: [], resultArtifactIds: [], revision: 1,
    runnerResumeHandle: { kind: "runner_native", runnerId: "offline-fixture", verified: false },
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

function project(value, t) {
  const before = structuredClone(value);
  const rows = buildConversationApprovalCheckpointRows({ checkpoints: [value], t });
  assert.deepEqual(value, before, "formatting cannot change the checkpoint or its execution evidence");
  return [...rows.evidenceRows, ...rows.attentionRows];
}

function resumeLine(rows, t) {
  assert.equal(rows.length, 1);
  const prefix = t(resumeKey, { status: "" });
  const lines = rows[0].detailLines.filter((line) => line.text.startsWith(prefix));
  assert.equal(lines.length, 1, "the checkpoint must contain exactly one resume-handle detail");
  return lines[0].text;
}

test("C003 authored and compiled Gujarati distinguish verified from unverified", () => {
  const authored = JSON.parse(readFileSync(new URL("../../../packages/localization/catalogs/gu-IN.json", import.meta.url), "utf8"));
  assert.equal(authored.messages.unverified, "ચકાસાયેલ નથી");
  assert.equal(authored.messages.verified, "ચકાસાયેલ");
  assert.equal(gujarati.messages.unverified, authored.messages.unverified);
  assert.equal(gujarati.messages.verified, authored.messages.verified);
});

for (const catalog of catalogs) {
  const t = translator(catalog.messages);
  for (const status of ["pending", "resume_pending", "resume_failed"]) {
    test(`C003 ${catalog.locale} ${status}: real checkpoint details preserve resume verification polarity`, () => {
      const unverified = project(checkpoint({ status }), t);
      const verified = project(checkpoint({ status,
        runnerResumeHandle: { kind: "runner_native", runnerId: "offline-fixture", verified: true } }), t);
      const unverifiedText = resumeLine(unverified, t);
      const verifiedText = resumeLine(verified, t);
      assert.equal(unverifiedText, t(resumeKey, { status: catalog.unverified }));
      assert.equal(verifiedText, t(resumeKey, { status: catalog.verified }));
      assert.notEqual(unverifiedText, verifiedText);
      assert.equal(unverified[0].id, verified[0].id);
      assert.equal(unverified[0].meta, verified[0].meta);
      assert.equal(unverified[0].tone, verified[0].tone);
    });
  }

  test(`C003 ${catalog.locale}: no resume handle adds no verification claim`, () => {
    const rows = project(checkpoint({ runnerResumeHandle: undefined }), t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detailLines.length, 3);
    assert.equal(rows[0].detailLines.some((line) => line.text.startsWith(t(resumeKey, { status: "" }))), false);
  });

  for (const status of ["approved", "resumed"]) {
    test(`C003 ${catalog.locale}: ${status} checkpoints remain hidden`, () => {
      assert.deepEqual(project(checkpoint({ status }), t), []);
    });
  }

  test(`C003 ${catalog.locale}: unspecified verification keeps the existing projection contract`, () => {
    const rows = project(checkpoint({ runnerResumeHandle: { kind: "runner_native", runnerId: "offline-fixture" } }), t);
    assert.equal(resumeLine(rows, t), t(resumeKey, { status: catalog.verified }));
  });
}

test("C003 missing Gujarati verification key uses the real English fallback", () => {
  const { unverified: omitted, ...partialCatalog } = gujarati.messages;
  assert.equal(typeof omitted, "string");
  const t = translator(partialCatalog);
  assert.equal(resumeLine(project(checkpoint(), t), t), t(resumeKey, { status: "unverified" }));
});

test("C003 absent selected catalog preserves the default English checkpoint details", () => {
  const t = translator({});
  assert.equal(resumeLine(project(checkpoint(), t), t), "Resume handle: unverified");
});
