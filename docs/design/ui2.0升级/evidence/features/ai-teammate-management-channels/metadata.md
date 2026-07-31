# P8.1h AI Teammate Channels Evidence Metadata

## Scope And Status

- Captured and verified: 2026-07-22, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Surface: real Vite Web application entered through AI teammate private workspace > Settings > Channels.
- Function ID: `TEAMMATE-CHANNELS-001` Web `verified`.
- Business boundary: existing `GET/PUT /teammates/:id/channels` full-replacement contract only. No API, contract,
  database, Channel lifecycle, Task, MCP, Danger or private-chat behavior changed.
- Desktop boundary: no packaged macOS/Windows claim is made by this Web evidence.

## Verification

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-teammate-management-channels.spec.ts
corepack pnpm --filter @ling-stack/web test:e2e -- teammates.spec.ts ui2-settings-workspace-tools.spec.ts dark-mode.spec.ts
git diff --check
```

Results:

- focused Channels: `7/7` passed;
- Teammates + Settings embedded + Dark regression: `30/30` passed;
- Web typecheck and i18n audit passed;
- focused CSS scan found no color literal, `!important`, `transition: all`, private keyframe or package-private
  `.ling-ui-*` selector;
- `git diff --check` passed at closeout.

The focused suite asserts exact full-replacement payloads, Join/Leave/Set default, row-scoped busy, protected zero
PUT, paused/archived reasons, initial failure/Retry, retained stale refresh, row mutation failure, success Toast,
teammate identity races, shared Input focus containment, root overflow and exactly 100 rows in one bounded scroll owner.

## Screenshot Ledger

| File | Viewport / theme / locale | Reachable state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-membership-actions.png` | `1440x960` / Light / en-US | joined/default/not-joined rows after Join, Leave and Set default; success Toast visible | `b32f27f9f0c26e438801279ff887df289ad32793f5f6b5b5185dd839bbfe1952` |
| `1280x800-ling-dark-lifecycle-zh-CN.png` | `1280x800` / Dark / zh-CN / reduced motion | long teammate/channel names, paused and archived disabled reasons, keyboard focus sequence | `cd1f20b49ae0f11774034bb8517fcef27c82c62a34aede5917c2c8bba2297fba` |
| `1440x960-ling-dark-retained-refresh-error.png` | `1440x960` / Dark / en-US | authoritative rows retained after refresh failure with scoped Retry | `8850583f75ca01bca753f5cf9fa14d292a15c4ceafef4d30083556d32b86c88e` |
| `1280x800-ling-light-search-no-result.png` | `1280x800` / Light / en-US | local no-result and Clear filters; separate empty catalog state asserted after capture | `4bc49dd06feacedba0c3cf17fe88a8c0f09a66ad84ee43f52156287b24bfc000` |
| `1280x800-ling-dark-row-mutation-failure.png` | `1280x800` / Dark / en-US | mutation failure remains under the initiating row while other actions remain enabled | `6ba1c8b649b02aa37cf62a71e813756fdcfee01af207d0cd2c0ccf81c70c99cb` |
| `1440x960-ling-light-protected-100-row-scroll.png` | `1440x960` / Light / en-US | protected Ling Agent, exactly 100 read-only Always joined rows, no mutation controls | `57722ef19a800526538e0edd4b0a39873a1bb0ad0e517c349bf8d30fa2583313` |

## Original-Size Visual Review

All six PNGs were inspected at original resolution after the passing focused run:

- toolbar, search Input, lifecycle Select and Refresh remain inside the content column;
- long Chinese/English identity text truncates without widening the page;
- Light and Dark surfaces remain coherent and status color is limited to real state;
- row actions do not wrap or overlap relationship/lifecycle text at either target viewport;
- stale and mutation feedback stay with their owning surface;
- the protected 100-row list scrolls internally without document overflow.

No visual defect requiring a production-code change was found in this archive.

## Remaining Boundaries

- `TeammateWorkspace.tsx` remains a 1,760-line architecture-debt composition owner. Channels logic is extracted, but
  future Tabs must not add major state or UI logic back into it.
- This closeout does not close teammate MCP or Danger, Council Channels, or packaged Desktop platform evidence.

## 2026-07-31 Archived-Channel Omission Evidence

The evidence above remains the historical 2026-07-22 closeout. The six existing filenames were recaptured after the
teammate relationship editor stopped displaying archived Channels. Their original hashes above are therefore obsolete
for the files currently on disk.

Archived Channels are absent from rows, totals, search results and filter options. Existing archived memberships remain
in the normalized full-replacement payload when another Channel is joined, left or made default; this prevents a
presentation-only change from deleting historical relationships.

| File | Current SHA-256 |
|---|---|
| `1440x960-ling-light-membership-actions.png` | `0c4e91fbf98bf0110cb6c38503a53873e9742e8a5ac2226169077bcbaa93cba2` |
| `1280x800-ling-dark-lifecycle-zh-CN.png` | `10870e633276d23b95b547aea8596f3a39db09324b93156920b330b99f6faca2` |
| `1440x960-ling-dark-retained-refresh-error.png` | `d000c99b38cc5c985b5dbb32f8f9d605709ca9fc208547b401b83fe98110e2b0` |
| `1280x800-ling-light-search-no-result.png` | `8b70856701990571adc87b0524ed0fa8e1ca5e5e37aff68c07c48a1eb4e376bb` |
| `1280x800-ling-dark-row-mutation-failure.png` | `178e4e58acd8bbae2e48d7b437d04da8c668ccc096df5bde50b0c5fb801ef5b0` |
| `1440x960-ling-light-protected-100-row-scroll.png` | `5b579668bef4acf0e085e66badcdab92c01d3b72b96de93194c76a46d945d9d0` |

Focused Channels passed `7/7`; Web typecheck and UI2 lint passed. The Light `1440x960` and Dark `1280x800` captures
were reviewed at original resolution with no root overflow, console error or action collision. No API, contract,
database, Channel lifecycle or membership persistence semantic changed.
