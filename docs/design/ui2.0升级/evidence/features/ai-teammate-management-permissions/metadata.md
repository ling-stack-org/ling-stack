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

## 2026-07-31 Replacement Evidence

The capture and verification record above remains historical evidence for the former read-only Permissions Tab. It no
longer describes the reachable product surface. The current ordinary-teammate navigation combines permissions and MCP
authorization under `Tools and permissions`; protected Ling Agent does not expose this editable section.

The current teammate may enable or disable its own supported tools and choose its additional high-risk confirmation
level. The existing teammate update contract remains the only persistence owner. Workspace policy is still the
authoritative ceiling: a teammate cannot override a Workspace deny, and only an actual Workspace restriction exposes a
scoped repair action. Healthy state has no jump to global Settings. MCP authorization is composed into the same section
only when at least one Server exists.

| File | Viewport / Theme | Current state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-editable-tools-permissions.png` | 1440x960 / `ling-light`, en-US | editable current-teammate capabilities, additional confirmation level, no redundant technical disclosure and saved Toast | `7259ec819941160f37f636c69f35662f4a0b64e18bd26c11c0cf5bc4f5d7c801` |
| `1280x800-ling-dark-workspace-deny-zh-CN.png` | 1280x800 / `ling-dark`, zh-CN | Workspace deny remains authoritative and provides the only scoped repair route | `e3b6ea7c5fc53103a1f28f1848eb8c233cde502b93d637a0b910e177e3968ddb` |

Both current PNGs were reviewed at original resolution. The complete teammate-management matrix passed `48/48`, MCP
input/status regression passed `7/7`, and Web typecheck, lint, i18n and unit tests passed. No daemon route, contract,
SQLite schema or permission-precedence rule changed.

The screenshots above are recaptured whenever the focused evidence test runs. The current permission surface omits the
former `Technical information` disclosure entirely; raw tool ids, required actions and per-tool Workspace decision
rows are no longer a user-facing layer.

The disclosure-removal recapture passed the focused Permissions suite `4/4`, Web typecheck, lint, i18n and
`git diff --check`. The wider teammate-management `48/48` result above remains the immediately preceding integration
baseline and was not repeated after this layout-only removal.

## 2026-07-31 External Tools Replacement Evidence

The former teammate MCP tree is replaced by the user-facing `External tools` section inside `Tools and permissions`.
The default layer shows only service name, productized availability, allowed capability count and Manage. A shared
right Drawer owns capability selection; raw names, server ids, transport, secret state, bulk future-tool authorization
and connection-layer descriptions remain absent. Existing teammate MCP bindings and Run filtering remain authoritative.

| File | Viewport / Theme | Current state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-external-tools-list.png` | 1440x960 / `ling-light`, en-US | compact service list, one allowed capability, Header-owned save and restored keyboard focus | `d02bdd2ae02daf8387013f7e6a4bb81396b9b688beb7ac581c8522ad11ac5d91` |
| `1280x800-ling-dark-external-tools-drawer.png` | 1280x800 / `ling-dark`, en-US, reduced motion | disabled service, natural-height capability list and no new-grant control | `f2d9d2eca8fa0ecade682c3ca1990b33893941380a1674e47147f9de35707edd` |

Both PNGs were reviewed at original resolution. The focused external-tool plus MCP integration matrix passes `7/7`,
legacy-writer regression passes `8/8`, and Web typecheck, lint, i18n plus `git diff --check` pass. Browser assertions
cover Drawer Escape/focus restoration, search/filter, selected payloads, disabled-service revocation, productized
failure copy, stale identity ownership, Light/Dark overflow and empty-service suppression.
