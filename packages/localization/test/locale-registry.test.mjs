import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCALE_DESCRIPTORS,
  SUPPORTED_LOCALES,
  createLocaleFormatters,
  formatServerCatalogMessage,
  isSupportedLocale,
  matchSupportedLocale,
  normalizeLocale,
  responseLanguageInstruction,
} from "../dist/index.js";
import { SUPPORTED_CATALOG_LOCALES, TRANSLATION_TARGETS } from "../scripts/catalog-locales.mjs";

test("registry exposes the exact 55 Codex product locales", () => {
  assert.equal(SUPPORTED_LOCALES.length, 55);
  assert.equal(new Set(SUPPORTED_LOCALES).size, 55);
  assert.deepEqual(Object.keys(LOCALE_DESCRIPTORS), [...SUPPORTED_LOCALES]);
  assert.deepEqual(SUPPORTED_CATALOG_LOCALES, [...SUPPORTED_LOCALES]);
  assert.deepEqual(
    Object.keys(TRANSLATION_TARGETS),
    SUPPORTED_LOCALES.filter((locale) => locale !== "en-US" && locale !== "zh-CN"),
  );
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(isSupportedLocale(locale), true);
    assert.equal(LOCALE_DESCRIPTORS[locale].locale, locale);
    assert.ok(LOCALE_DESCRIPTORS[locale].nativeName.length > 0);
    assert.ok(LOCALE_DESCRIPTORS[locale].englishName.length > 0);
    assert.equal(LOCALE_DESCRIPTORS[locale].direction, "ltr");
  }
});

test("normalizes aliases and regional variants without persisting aliases", () => {
  assert.equal(normalizeLocale("zh_Hans"), "zh-CN");
  assert.equal(normalizeLocale("zh-MO"), "zh-TW");
  assert.equal(normalizeLocale("es-MX"), "es-419");
  assert.equal(normalizeLocale("pt"), "pt-BR");
  assert.equal(normalizeLocale("no"), "nb-NO");
  assert.equal(normalizeLocale("de-AT"), "de-DE");
  assert.equal(normalizeLocale("not-a-locale"), undefined);
});

test("matches navigator language order and preserves the Ling fallback", () => {
  assert.equal(matchSupportedLocale(["xx-YY", "ja-JP"]), "ja-JP");
  assert.equal(matchSupportedLocale(["xx-YY"]), "zh-CN");
  assert.equal(matchSupportedLocale([], "en-US"), "en-US");
});

test("builds stable response instructions and Intl formatters for every locale", () => {
  const sampleDate = new Date("2026-08-27T08:30:00.000Z");
  for (const locale of SUPPORTED_LOCALES) {
    assert.match(responseLanguageInstruction(locale), /^Use .+ for user-visible output;/);
    const formatters = createLocaleFormatters(locale);
    assert.ok(formatters.number.format(1234.5));
    assert.ok(formatters.compactNumber.format(12500));
    assert.ok(formatters.date.format(sampleDate));
    assert.ok(formatters.dateTime.format(sampleDate));
    assert.ok(formatters.relativeTime.format(-1, "day"));
    assert.ok(formatters.list.format(["A", "B"]));
  }
});

test("ships synchronous daemon fallback copy for every locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const message = formatServerCatalogMessage(locale, "daemon.workflow.succeeded", { title: "Example" });
    assert.notEqual(message, "daemon.workflow.succeeded");
    assert.match(message, /Example/u);

    const permission = formatServerCatalogMessage(
      locale,
      "daemon.channel.proposal.risk.permission",
      { tools: "bash", target: "project tests" },
    );
    assert.notEqual(permission, "daemon.channel.proposal.risk.permission");
    assert.match(permission, /bash/u);
    assert.match(permission, /project tests/u);
  }
});
