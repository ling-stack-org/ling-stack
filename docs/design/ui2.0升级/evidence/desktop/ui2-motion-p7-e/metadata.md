# P7-E Motion And Input Packaged Evidence

## Scope And Status

- Slice: `T13-P.7-E12-E14`.
- Function IDs: `UI-MOTION-TOKENS-001`, `UI-MOTION-MIGRATION-001`.
- Platform: real Apple Silicon macOS `26.5.2`, packaged `darwin-arm64` Electron application.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Evidence date: `2026-07-27`.
- Candidate: unsigned `0.0.0`, built from the intentionally dirty shared worktree.

The Web implementation and macOS arm64 packaged sub-gate are complete. The canonical Motion IDs are
`implemented`, not globally `verified`: real Windows 11 x64 motion/DPI evidence is absent, and the packaged
first-frame lifecycle harness retained one macOS window-capture failure described below.

## Candidate Identity

| Field | Value |
|---|---|
| Application ID | `com.lingstack.desktop` |
| ZIP SHA-256 | `4d90971b2a2e6ad5616e5b633e343d14af4db070ffa0c7a24047df73aae621e5` |
| Executable SHA-256 | `997d6e26011b89344f98626987155158f13f492148f79bc00f24d841ae693b60` |
| `app.asar` SHA-256 | `51c4047ae9ef0b6bd640ce99bbda6df67b8c7e5f3a6861399e841a7ae3f9176c` |
| Candidate state | unsigned, dirty-worktree implementation evidence only |

The packaged main window loaded the bundled
`Contents/Resources/web/index.html`; it did not use Vite, a browser fixture or the older release artifact.

## Shared Input Containment

The packaged AI teammate Search field was opened and focused through the real toolbar. CDP geometry and computed
styles recorded:

| Measurement | Before focus | After focus |
|---|---:|---:|
| Shared shell height | `32px` | `32px` |
| Native input height | `30px` | `30px` |
| Native top / bottom | `8.5 / 38.5` | `8.5 / 38.5` |
| Shell top / bottom | `7.5 / 39.5` | `7.5 / 39.5` |

- Native border / outline / shadow: `0px / 0px / none`.
- Shell overflow: `hidden`; native input remained within both shell edges.
- Focus changed the header field border from `rgb(68, 78, 90)` to `rgb(138, 168, 199)` without changing geometry.
- Document horizontal overflow: `0px`.
- Web AST guard remains `reachable=0, decision-gated=1/1`; the decision-gated Work Thread search is not enabled.

## Motion Measurements

### Sidebar normal motion

- Computed transition: `grid-template-columns 0.24s cubic-bezier(0.2, 0, 0, 1)`.
- Start: `240px`.
- After 80ms collapse: `111.578125px`.
- The user action was reversed at that computed position.
- After 70ms reverse: `206.375px`.
- Final: `240px`, without jumping to the collapsed endpoint first.

### Reduced motion

With packaged Chromium emulating `prefers-reduced-motion: reduce`:

- `matchMedia` returned `true`.
- Sidebar computed transition duration was `0s`.
- Width changed from `240px` to `48px` by the next frame and restored to `240px` by the next frame.
- WorkCell focused E2E separately proves the unique active shimmer stops offscreen, on completion and under reduced
  motion, then resumes only after the active cell re-enters the viewport.

## Automated Gates

- `@ling-stack/ui-react`: `70/70`.
- Shared Form focus geometry: `4/4`.
- Channel / Normal / AI teammate Header Search: `8/8`.
- Sidebar motion and foundation: `12/12`.
- WorkCell activity: `6/6`.
- Web typecheck, lint, motion/icon/text-control guards and `git diff --check`: passed.
- Desktop production build and arm64 ZIP packaging: passed.
- Packaged lifecycle harness: `5/6`, zero runtime errors; gate remains failed because the second launch could not
  be matched to a WindowServer window within 5 seconds.

The failed harness step still recorded a complete renderer, the expected `packaged-smoke` theme, matching bootstrap
selection and first-paint snapshot, and the first-observed content SHA-256
`c27a6e4a1258395cc2361fa7b4028d07613ae6b4e0e4e2cbe7be8b2d69257cd2`. A separate direct packaged launch then
produced the two window captures in this directory and the computed measurements above. This supplements the failed
window capture; it does not rewrite the harness result as passed.

## Screenshots

| File | Captured surface | SHA-256 |
|---|---|---|
| `1440x920-macos-arm64-packaged-ling-dark.png` | Packaged Dark home and native macOS chrome | `7195ac2634fa0fcf96efc3d53b0702c62eaca6f77457cfcaf35f60082258b7f6` |
| `1440x920-macos-arm64-packaged-teammate-search-focus.png` | Packaged AI teammate Search focused state | `6033fb18e480a90287b725296f272d996439866a56b75df0052a8f9a148f3a49` |

Both PNG files are `1508x988` physical pixels because `screencapture` includes the Retina window boundary and
shadow around the `1440x920` Electron content window. Both were inspected at original resolution; the Search native
control stays inside its 32px header shell and neither page has incoherent overlap.

## Honest Boundaries

- No real Windows 11 x64 host, DPI scaling or High Contrast evidence was available.
- The candidate is unsigned and not notarized; it is not a release promotion artifact.
- The macOS lifecycle harness remains failed `5/6` because formal restart window capture failed, even though its CDP
  first-frame state was correct and the direct packaged window was captured afterward.
- No claim is made for Intel macOS x64, Windows title-bar behavior, installer behavior or production distribution.
