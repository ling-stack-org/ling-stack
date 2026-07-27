# P8.1j AI Teammate Permissions Evidence

## Scope

- Captured: 2026-07-21, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, commit, push, rebase or merge.
- Surface: real Vite application with Playwright daemon fixtures, not a static component screenshot.
- Function ID: `TEAMMATE-PERMISSIONS-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

The Permissions Tab is read-only. It separates the teammate capability ceiling from the Workspace default runtime
preview and uses Core `resolveSessionRunPolicy()` for the latter. A teammate profile may add approval requirements but
cannot turn a Workspace `deny` into `ask` or `allow`. Channel, Skill, session and concrete Run context may restrict the
preview further. The surface does not edit policy, claim exact effective Run authority, add API/database fields or
expose a Save action. `Open authorization settings` routes to the existing Settings owner.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-read-only-ceiling.png` | 1440x960 / `ling-light` | ordinary teammate capability ceiling and folded details | `05477667e242e48fb331954ffd05fd80dc8f4d38521c657617376b3dda683bf5` |
| `1440x960-ling-light-policy-requirements.png` | 1440x960 / `ling-light` | raw IDs and required tool/action detail explicitly opened | `41163f61728babd35ad4334b297898d4f58ebb777b7b27969d4e8d43c5dfeceb` |
| `1280x800-ling-light-protected-managed.png` | 1280x800 / `ling-light`, zh-CN | managed Ling Agent, seven-tool ceiling and no editable control | `14c346c6b6aa5750a1b4a0f0c1efd7bdd89eac65c3b10bdd4ab0ce39d94d1dc0` |
| `1280x800-ling-dark-strict-details-zh-CN.png` | 1280x800 / `ling-dark`, zh-CN, reduced motion | legacy empty ceiling, strict/critical profile and folded requirements | `d9d0d316d581cd0b6bf2cf7700898aba7b88ecbddb56f6c42f97a125864fcfdb` |
| `1440x960-ling-dark-workspace-deny-preview.png` | 1440x960 / `ling-dark` | Workspace deny remains authoritative and default tool decisions are open | `a4d5378125c80f20086b739276c4b4f4e271b828e7306b9175d251accd5e0977` |
| `1280x800-ling-dark-policy-error-reduced-motion.png` | 1280x800 / `ling-dark`, reduced motion | scoped policy-load failure with Retry and retained teammate truth | `ffae3c5e7840683ed6348deb4b35b34dc8966528cad1a765d731658953ad4d70` |

All six PNG files were reviewed at original resolution. Header status, approval mode, authorization/access and
allow/ask/deny decisions remain visible as text rather than dot-only decoration. The Settings navigation, central
scroll owner and right configuration summary do not overlap. Both viewports remain document-contained; long teammate
identity truncates in the shell while the current section remains readable. Light/Dark semantic warning and failure
surfaces use tokens and do not introduce hard-coded white, black or status colors.

## Reachable State Evidence

- ordinary and managed teammate paths remain visually distinct without disabled fake controls;
- none/standard/strict approval copy never claims that Workspace approval is bypassed;
- no tools, one tool and many tools produce truthful capability counts; raw IDs stay folded by default;
- required tool and action details remain keyboard-reachable in one shared `InspectorSection`;
- canonical authorization/access plus Workspace allow/ask/deny are resolved by Core, not JSX;
- Workspace deny remains authoritative even when the teammate profile requests approval for the same tool;
- policy loading has stable Skeleton geometry; failure is local, persistent and retryable; Retry restores the
  authoritative projection without a page reload;
- switching from a denied medium-risk teammate to a low-risk teammate does not retain the prior identity or status;
- Ling Agent remains managed, read-only and reachable in zh-CN; the right summary now says no *extra* approval rather
  than the misleading no-approval claim;
- reduced motion adds no Feature animation, and every focused scenario asserts empty browser errors and no document
  overflow.

## Verification

- `ui2-teammate-management-permissions.spec.ts`: `5/5`, including final evidence capture.
- Profile/Model/Skills/Settings authorization/Settings workspace-tools/Teammates/Dark selected regression: `60/60`.
- Web `typecheck`, `check:i18n` and `git diff --check`: passed.
- Direct Feature Radix imports: zero; the Tab uses shared `DataRow`, `StatusIndicator`, `Badge`, `InspectorSection`,
  `InlineFeedback`, `Skeleton` and `Button` only.
- Focused CSS hard-coded color, `!important`, Theme/Profile id, `transition: all`, private keyframe and package-private
  `.ling-ui-*` selector hits: zero.

## Structure And Residual Risk

- Focused owners: 233-line pure view-model, 252-line Tab, 217-line CSS and 315-line focused E2E.
- `AppShell.tsx` only starts the existing approval-policy refresh for the Teammates view and passes loading/error/retry
  plus the existing Settings route; it contains no new permission projection.
- `TeammateWorkspace.tsx` is 2,123 lines and remains above the 1,200-line architecture-debt threshold. This slice adds
  only typed composition props; Tasks, Activity, Memory, MCP and Channels must keep extracting state rather than append
  major behavior.
- No API, contract, database, route, policy precedence or protected-teammate mutation behavior changed.
- `TEAMMATE-TASKS-001` and Council A were confirmed separately and are not claimed by this evidence package.
