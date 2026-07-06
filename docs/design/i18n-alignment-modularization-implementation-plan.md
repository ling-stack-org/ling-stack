# I18n Alignment And Modularization Implementation Plan

## Summary

This pass aligns user-visible English/Chinese copy after recent product UI changes and
extracts the locale dictionaries out of `i18n.tsx`. It does not change routing, backend
contracts, or locale fallback behavior.

## Implementation Plan

- Add a temporary audit step based on the TypeScript compiler API to collect:
  literal `t("...")` keys, dynamic `t(...)` call sites, dictionary key counts,
  duplicate keys, `zh-CN` missing keys, and historical key candidates.
- Move dictionaries to focused locale modules:
  `apps/web/src/i18n/locales/en-US.ts`, `apps/web/src/i18n/locales/zh-CN.ts`, and
  `apps/web/src/i18n/dictionaries.ts`.
- Keep `apps/web/src/i18n.tsx` as the public module for `Locale`, `Translate`,
  `I18nProvider`, `useI18n`, and `LanguageSwitcher`.
- Add Chinese translations for all currently missing literal Web keys.
- Delete the small set of old English-dictionary-only compatibility keys that are not
  referenced by current source and are already represented by English-key entries.
- Record evidence from the audit and test commands in this plan after implementation.

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
- `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts media-jobs.spec.ts teammates.spec.ts councils.spec.ts`

## Implementation Evidence

- Added `apps/web/scripts/check-i18n.mjs` and `corepack pnpm --filter @ling-stack/web check:i18n`.
- Split locale dictionaries into:
  - `apps/web/src/i18n/locales/en-US.ts`
  - `apps/web/src/i18n/locales/zh-CN.ts`
  - `apps/web/src/i18n/dictionaries.ts`
- Reduced `apps/web/src/i18n.tsx` to provider/runtime exports only.
- Current file sizes:
  - `apps/web/src/i18n.tsx`: 110 lines
  - `apps/web/src/i18n/locales/en-US.ts`: 2392 lines
  - `apps/web/src/i18n/locales/zh-CN.ts`: 4133 lines
  - `apps/web/scripts/check-i18n.mjs`: 137 lines
- Audit output:
  - `en-US=2393`
  - `zh-CN=4121`
  - `literalKeys=2817`
  - `dynamicCalls=220`
  - no duplicate keys
  - no missing `zh-CN` literal keys
- Validation:
  - `corepack pnpm --filter @ling-stack/web check:i18n`: pass
  - `git diff --check`: pass
  - `corepack pnpm --filter @ling-stack/web typecheck`: pass
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts teammates.spec.ts`: 31 passed
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts model-workbench.spec.ts media-jobs.spec.ts teammates.spec.ts councils.spec.ts automations.spec.ts app.spec.ts`: 64 passed

## Acceptance Checklist

- [x] `i18n.tsx` keeps locale/provider/runtime logic and no longer stores the full dictionaries.
- [x] Chinese locale covers every currently audited literal `t("...")` source key.
- [x] Duplicate dictionary keys are rejected by the audit script.
- [x] Stale English-only historical keys were removed conservatively.
- [x] Dynamic `t(...)` call sites are counted and left for manual/domain-aware follow-up instead of mass deletion.
- [x] Settings and AI teammate e2e assertions were updated for the intended Chinese localized labels.
- [x] Large-file risk moved out of `i18n.tsx`; remaining locale files are intentionally data-heavy and should be split by surface in a future cleanup only if review/merge pressure justifies it.

## Assumptions

- Desktop Web remains the acceptance target.
- English literal keys may display through fallback in English; Chinese locale should not
  leak English for literal UI keys.
- Dynamic keys are audited but not aggressively deleted in this pass.
