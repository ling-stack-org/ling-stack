# I18n Alignment And Modularization

Status: superseded historical baseline
Owner: Web maintainers
Last verified: 2026-08-27
Canonical replacement: [Ling Internationalization And Language Parity](./internationalization-language-parity.md)

This document records the original two-language extraction baseline. It is no longer the
implementation contract. The canonical contract now covers 55 product locales, Web,
Daemon, Desktop, catalog automation, and packaged acceptance.

## Related Docs

- [Ling UI 2.0 整体升级方案](./ui2.0升级/00-UI2.0整体升级方案.md)
- [Settings Shell](./ui2.0升级/modules/settings/README.md)

## Summary

Ling Web uses English strings as most product copy keys and falls back to the key for
English display. Chinese display must not rely on that fallback for visible UI copy.
After the P0-P5 product and Settings changes, the i18n table needs a cleanup pass:

- Keep runtime translation behavior unchanged.
- Ensure every literal `t("...")` key used by Web has a Chinese translation when it is
  user-visible English copy.
- Remove old compatibility keys that are no longer referenced by source code.
- Split dictionary data away from the provider/runtime code so `i18n.tsx` stops carrying
  thousands of translation lines.

## Decisions

- English dictionary coverage may remain sparse for English literal keys because the
  translation key itself is the English fallback.
- Chinese dictionary coverage is the acceptance gate for visible English literal keys.
- Dynamic keys such as role/status/plugin codes are not mass-deleted; they may be
  resolved through helpers or domain data.
- Modularization starts with a low-risk seam: `i18n.tsx` keeps React provider/runtime
  logic, while locale dictionaries move under `apps/web/src/i18n/`.
- Per-surface dictionary chunking is a follow-up after the first extraction, because
  doing both in one pass would make review and merge conflicts much riskier.

## Acceptance Criteria

- `i18n.tsx` contains provider/runtime logic only, not the locale dictionaries.
- English and Chinese locale files have no duplicate keys.
- Every literal `t("...")` call used in `apps/web/src` has a `zh-CN` translation.
- Removed keys must be safe historical leftovers, not dynamic status or domain labels.
- Typecheck and focused locale e2e still pass.
