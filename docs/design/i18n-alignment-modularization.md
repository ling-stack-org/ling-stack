# I18n Alignment And Modularization

## Related Docs

- [Product UX System P5](product-ux-system-p5.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)

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
