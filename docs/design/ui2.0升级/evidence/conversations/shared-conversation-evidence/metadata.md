# Shared Conversation Evidence

## Scope

T13-O.11 migrates the live Conversation Evidence presentation shared by Channel messages, AI teammate private
messages and Runs diagnostics from `components.css` into `styles/shared/conversation-evidence.css`. It also replaces
the raw disclosure button with the shared `Button` while preserving local open state, `aria-expanded`, projection,
filtering and safe-link behavior. Blocked and degraded web diagnostics remain outside primary message evidence.

## Evidence

| File | Viewport / theme | Reachable state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-web-evidence.png` | 1440x960 / Ling Light | available web source stack, expanded disclosure, safe source/opened URL links, blocked/degraded diagnostics separated | `7db4ac3728bd3c2b99fb7cfe0c7e0e613287ab621b3729ebc06618465cc7f284` |
| `1280x800-ling-dark-teammate-memory-evidence.png` | 1280x800 / Ling Dark / reduced motion | private memory evidence expanded with Space, long memory scope/content contained | `7f05c38f42ee80b174f2a80b41dd789ba8e7897a8b4c2cb073eee99196bba04a` |
| `1440x960-ling-light-runs-evidence.png` | 1440x960 / Ling Light | Runs evidence summary, long code/link/status, memory disclosure expanded with keyboard | `6b3b3428123b67337ae350e141c9360d467ad4b9060cabff8d194f6e6b9a9ac1` |

All three images were inspected at original size. The evidence owner, message/feed and document remain horizontally
contained; no mixed-theme surface, incoherent overlap, clipped status/link, console error or page error was observed.
The visible blue disclosure outline is the shared Button keyboard focus state, not an overflowing text-input layer.

## Verification

- focused capture: `ui2-conversation-evidence.spec.ts` `3/3`;
- Runs/Threads: `ui2-runs-threads.spec.ts` `7/7`;
- AI teammate Feed/Composer: `ui2-teammate-conversation-feed-composer.spec.ts` `4/4`;
- Channel web evidence regression: `channel.spec.ts` focused scenario `1/1`;
- Input containment side-check prompted by screenshot review: shared Input, legacy Input and Channel Header/Search `7/7`;
- Web `check:i18n`, lint, typecheck, production build and `git diff --check` passed;
- focused CSS has zero color literals, `!important`, Theme selectors, `transition: all`, private keyframes, literal
  z-index and package-private `.ling-ui-*` selectors;
- `components.css` Evidence source roots and production `.teammate-avatar-stack*` CSS references are zero.

## Result

`components.css` is 7,842 lines and the focused owner is 309 lines. The Web CSS tree is 147 files / 38,669 lines.
No Function ID, API, contract, domain state, package export or packaged Desktop status changed.

T13-O.13 recaptured this suite after `ConversationSummaryRow` moved into the shared Summary owner. Focused `3/3`
remained green; the Runs row keeps long code/link/status contained, and original-size review found no new overlap or
horizontal overflow. The table hashes above are the current recapture.
