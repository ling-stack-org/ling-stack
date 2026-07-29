# AI Teammate Role Detail Evidence

## Scope

- Slice: `T13-O.10 Teammate Role Detail focused owner`.
- Source: branch `codex/ui2-desktop-coverage-foundation`, HEAD `0a0b8050`, mixed Desktop/Computer Use/UI 2.0 working tree preserved.
- Runner: Chromium through `@ling-stack/web` Playwright, one worker, mocked daemon with the built-in gstack role pack.
- Capture gate: `LING_CAPTURE_UI2_EVIDENCE=1`.

## Captures

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-default-collapsed.png` | `1440x960` / `ling-light` | Product Strategist opened from Settings; Advanced is closed; header, body and footer remain separate | `552ef9a554a8874ad7f93429e17573c5737ac72d9b8d139649f6ee1e212297b9` |
| `1280x800-ling-dark-advanced-workflow.png` | `1280x800` / `ling-dark`, reduced motion | Advanced meta, prompt and eight-step workflow visible after scrolling the single body owner | `48f99bdc61a7d44c0159d987e6de5639f742f4ff3ffff3278fa28ba998d90c90` |
| `1280x800-ling-light-zh-long-content.png` | `1280x800` / `ling-light`, `zh-CN` | Localized long content, meta, prompt, workflow and fixed footer remain contained | `7474b26443701a86179fbd3dd8259f878b2b74c5b6e3a1028aa2576bb1f7b232` |

## Assertions

- Focused `3/3`: default collapse, Esc and trigger focus return; Dark/reduced-motion Advanced workflow; zh-CN child/Dialog/document containment.
- Dialog keeps one vertical scroll owner: `.teammate-detail-sheet-body`; footer is outside the body and stays fixed.
- Meta, prompt, workflow lane, step cards and footer remain within the Dialog without horizontal overflow.
- Console and page errors are collected without a resource-error exclusion and remain empty.
- Existing Create `5/5`, Settings/Teammates/Dark `40/40`, and Channel plus Web release `117/117` passed.

## Visual Review

- Light and Dark surfaces use semantic Ling tokens; no hard-coded white/black patch is required.
- Advanced content is readable at `1280x800`; two-column workflow cards wrap without clipping.
- The role Dialog is a Portal surface and does not depend on `.workspace-teammates-surface` ancestry.
- Packaged macOS and Windows evidence remains a separate Desktop release gate.
