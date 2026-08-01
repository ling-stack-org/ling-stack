# Ling Mobile Conversation UI 2.0 Design QA

- Source visual truth: `/Users/tianxiao/.gstack/projects/tianxiaochannel-oss88-ling-stack/designs/mobile-conversation-sync-20260731/mobile-conversation-ui2-preview.html`
- Source board capture: `/var/folders/wv/szx379kx7r135_kzktxrrs680000gn/T/codex-clipboard-adad8a25-383a-498c-ad9d-32c7f170a0fd.png`
- Runtime: native React Native Release build on iPhone 17 Simulator, iOS 26.5
- Source phone viewport: 390 x 844 CSS px, source crops 390 x 844 px
- Implementation viewport: 402 x 874 CSS px, screenshots 1206 x 2622 px at 3x density
- Comparison normalization: source and implementation were each normalized to 402 x 874 px before side-by-side review

## Evidence

| State | Implementation | Side-by-side comparison |
| --- | --- | --- |
| Unpaired secure pairing | `/tmp/ling-mobile-ui2-qa/pairing-release.png` | `/tmp/ling-mobile-ui2-qa/pairing-comparison.png` |
| Unified conversation index | `/tmp/ling-mobile-ui2-qa/index-light-v2.png` | `/tmp/ling-mobile-ui2-qa/index-comparison.png` |
| Profile and appearance | `/tmp/ling-mobile-ui2-qa/profile-light-v2.png` | `/tmp/ling-mobile-ui2-qa/profile-comparison.png` |
| Channel detail | `/tmp/ling-mobile-ui2-qa/channel-light-v2.png` | `/tmp/ling-mobile-ui2-qa/channel-comparison.png` |
| Normal conversation detail | `/tmp/ling-mobile-ui2-qa/conversation-light-v2.png` | `/tmp/ling-mobile-ui2-qa/conversation-comparison.png` |
| Teammate direct detail | `/tmp/ling-mobile-ui2-qa/teammate-light-v2.png` | `/tmp/ling-mobile-ui2-qa/teammate-comparison.png` |
| Dark conversation index | `/tmp/ling-mobile-ui2-qa/index-dark-v2.png` | Token and system-appearance verification |
| Dark profile | `/tmp/ling-mobile-ui2-qa/profile-dark-v2.png` | Token and system-appearance verification |
| Dark channel detail | `/tmp/ling-mobile-ui2-qa/channel-dark-v2.png` | Token and system-appearance verification |

Focused comparisons were included for every major screen because typography, identity avatars, message alignment, controls, and composer details were too small to judge reliably from the full six-screen board alone.

## Required Fidelity Surfaces

- Fonts and typography: system SF typography, weights, sizes, line heights, truncation, and metadata hierarchy match the source. Line wrapping differs where expected because the simulator is 12 CSS px wider than the source phone.
- Spacing and layout rhythm: safe areas, header heights, list rows, 16 px side gutters, card radii, transcript gaps, and composer placement match the source proportions.
- Colors and tokens: Ling Light and Ling Dark values map directly from the HTML variables. Native iOS appearance is now `automatic`, and a dark-system Release run rendered the dark tokens.
- Image and icon fidelity: no source raster assets were required. Standard navigation, scan, sync, and chevron symbols use the Expo icon library; identity marks remain semantic text avatars as in the source.
- Copy and content: pairing, filters, profile preferences, PC binding, three conversation identities, teammate privacy note, reconnect labels, and composer placeholders match the source behavior and wording.

## Comparison History

### Iteration 1

- P1: the physical-device screenshot showed the Expo Development Build launcher instead of Ling UI.
- P1: the existing native screens used the earlier card-heavy layout rather than the selected HTML hierarchy.
- Fixes: rebuilt all six screens around the selected UI, moved to an embedded Release bundle, and added the exact Light/Dark tokens and semantic identity treatment.

### Iteration 2

- P2: single-name avatars rendered two letters, the empty composer rendered a gray send button, and the profile used an oversized native switch.
- Fixes: single-character identity initials, source-colored send button with logical disabled state, and a 45 x 28 accessible toggle matching the source.
- Post-fix evidence: the five light-mode side-by-side comparison files above contain no remaining actionable P0/P1/P2 visual differences.

### Iteration 3

- P1: native `UIUserInterfaceStyle` was locked to Light, so following a dark system did not change the app.
- Fix: set Expo `userInterfaceStyle` to `automatic`, regenerated the iOS project, and reran Release captures in dark mode.
- Post-fix evidence: dark index, profile, and channel captures render Ling Dark consistently.

## Findings

- No actionable P0/P1/P2 differences remain.
- P3: the sample design uses the profile glyph `田`, while runtime fallback initials derive from the actual profile name; this is intentional data-driven behavior and disappears when the user has an avatar.
- Expected: text wraps later on the 402 px simulator and the user's wider iPhone 13 Pro Max than on the 390 px source viewport.
- Expected: the reference index demonstrates a reconnect banner while its header still says synced. Runtime keeps those two status surfaces consistent, so the banner appears only while actually reconnecting.

## Interaction and Runtime Checks

- Release build launches directly into Ling without Metro or the Expo launcher.
- Paired and unpaired roots, all three conversation kinds, profile navigation target, filters, theme controls, and composer states were rendered from the production components.
- TypeScript, mobile contract tests, Expo Doctor, and native Release build are separate blocking checks run after visual QA.

final result: passed
