# P7B.2 Skill Library Evidence

## Capture Context

| Field | Value |
|---|---|
| Captured | 2026-07-20 |
| Branch | `codex/ui2-desktop-coverage-foundation` |
| HEAD | `0a0b8050` |
| Working tree | dirty, 386 porcelain entries at capture time; Desktop/Computer Use and UI 2.0 work are intentionally preserved together |
| Server | real Vite dev server at `http://127.0.0.1:4174` |
| Server command | `corepack pnpm exec vite --host 127.0.0.1 --port 4174` through Playwright `webServer` |
| Capture command | `LING_CAPTURE_UI2_EVIDENCE=1 corepack pnpm --filter @ling-stack/web test:e2e -- ui2-settings-skill-library.spec.ts` |
| Browser | Playwright Chromium, one worker |
| Data | deterministic mock daemon fixture; this proves the Web product surface and real browser interactions, not a live daemon or packaged Desktop host |

## Evidence Matrix

| File | Viewport | Theme / locale | Trigger and state | Result |
|---|---|---|---|---|
| `1440x960-ling-light-my-skills.png` | 1440x960 | `ling-light`, `en-US` | Settings > Skill library; loaded My skills row with deliberately long identity and summary | compact toolbar, stable action column, truncation without layout shift, no document or panel horizontal overflow |
| `1440x960-ling-light-editor.png` | 1440x960 | `ling-light`, `en-US` | Create skill; valid name, description and instruction; Advanced configuration folded | bounded shared Dialog, fixed header/footer, body scroll ownership, required fields and destructive row action remain legible |
| `1280x800-ling-dark-evolution-review.png` | 1280x800 | `ling-dark`, `en-US` | AI evolution > Skills to review; Ignore request held then failed | action-scoped busy, sibling disabled, persistent queue-local failure, no unrelated Inspector or page overflow |
| `1280x800-ling-dark-inspector-source.png` | 1280x800 | `ling-dark`, `en-US`, reduced motion | Select source-backed skill; Source and raw details opened before rollback | compact Inspector, folded technical hierarchy, bounded internal content, source history and rollback remain readable |
| `1280x800-ling-dark-import-failure.png` | 1280x800 | `ling-dark`, `zh-CN` | Import duplicate `SKILL.md` | validation remains inside shared Import Dialog; one file owner and one primary action; no page feedback wall |
| `1280x800-ling-dark-delete-failure-zh-CN.png` | 1280x800 | `ling-dark`, `zh-CN` | Permanent delete request returns 503 | destructive failure remains in confirmation Dialog; Esc closes and returns focus to the originating delete IconButton |

## Interaction And Runtime Checks

- Focus: Search focus leaves the 32px shell unchanged; native input stays inside the shell and owns no second shadow.
- Keyboard: AI evolution Tabs accept ArrowRight; Editor dirty Escape opens discard confirmation; Delete failure Escape restores the real row trigger.
- Overlay: Toast remains in the single application overlay root; Import, Editor and Delete use the shared Radix-backed Dialog owner.
- Busy state: source rollback, candidate review and permanent delete only disable their action scope.
- Feedback: successful import Toast expires within five seconds; review, import and delete failures remain in their owning surface.
- Motion: source Inspector scenario ran with `prefers-reduced-motion: reduce`; capture disables screenshot-time animations only.
- Console: all six scenarios completed with no collected `console.error` or `pageerror`.
- Overflow: E2E verified document containment in all scenarios and focused panel containment where applicable; the 55-row ownership regression separately verifies vertical internal scrolling without horizontal overflow.
- Visual review: all PNGs were opened at original resolution; no text/control overlap, clipped action labels, hard-coded light surface in Dark, or incoherent overlay stacking was found.

## Test Results At Capture

```text
@ling-stack/ui-react                         41/41 passed
ui2-settings-skill-library.spec.ts            4/4 passed
skill-library-ownership + import              7/7 passed
selected Settings/Dark/shared controls       27/27 passed
Web typecheck, check:i18n, lint, diff check   passed
```

## SHA-256

```text
2ee52bfa8350d8e538c5b295b883c396d8d925d97a1a5499c9378d040dde1d44  1280x800-ling-dark-delete-failure-zh-CN.png
32e15b368ebe0b3a73a571a594e1812c4045baf5192b2ad318801d66fa9a89fd  1280x800-ling-dark-evolution-review.png
06b98d641951d8a4f009f836ab376f9375a594510997f63a52a0e33052401673  1280x800-ling-dark-import-failure.png
26d8ed59624e3f42a03756d41d57c72217e76887507deaa8498037bd956a9506  1280x800-ling-dark-inspector-source.png
15692e5461e79721277e7ad7381ec4f050b1df5aac6b719b943438e1aa22ef11  1440x960-ling-light-editor.png
e11e58fc0d5698ddcf1331bcf864b7680cb3a58ec81bb69424adf615e7541a2b  1440x960-ling-light-my-skills.png
```

## Scope Boundary

- `SETTINGS-SKILL-SYNC-001` remains `inventory`: official source APIs exist, but no production entry is approved.
- This evidence does not change Skill authority, review/publish, checksum, version conflict, teammate binding or hard-delete semantics.
- This evidence does not prove a packaged macOS/Windows client or live daemon integration; those remain release and platform gates.
