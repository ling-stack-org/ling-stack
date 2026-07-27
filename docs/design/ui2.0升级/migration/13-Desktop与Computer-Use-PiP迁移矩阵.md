# Desktop 与 Computer Use PiP 迁移矩阵

## Scope

覆盖新拉取的 Electron Desktop 主窗口、current-session Computer Use capability、独立 PiP
renderer、Desktop-only CSS、主题同步、原生恢复 Dialog 和跨平台视觉验收。

## Function Matrix

| Function ID | Current owner | UI 2.0 target | Slice | E2E | Status |
|---|---|---|---|---|---|
| DESKTOP-SHELL-STARTUP-001 | `main.ts`, daemon lifecycle | focused startup composition | U4D | desktop node/smoke | implemented |
| DESKTOP-SHELL-STARTUP-FAILURE-001 | startup process exit/log only | typed Retry/Diagnostics/Quit native recovery | U4D.6 | daemon recovery + real Desktop | implemented |
| DESKTOP-SHELL-MAIN-WINDOW-001 | `window-factory.ts` | shared Web + bootstrap surface | U4D | desktop smoke, app | designed |
| DESKTOP-SHELL-RECOVERY-001 | native `showMessageBox` | typed native recovery catalog | U4D | daemon recovery | implemented |
| DESKTOP-SHELL-THEME-001 | hard-coded background | Theme Pack first-paint snapshot | U4D/U13 | dark-mode, desktop smoke | designed |
| DESKTOP-THEME-PACK-PERSISTENCE-001 | native repository + typed IPC/preload + Web/Desktop adapters + first-paint snapshot | `appData/themes/<id>` + staging/atomic rename + typed IPC + restart restore | U4D.7/P7C.D | desktop node/smoke + packaged macOS/Windows | inventory / partial |
| DESKTOP-SHELL-WINDOW-001 | BrowserWindow options/listeners | platform window adapter + shared geometry contract | U4D | desktop smoke/screenshots | designed |
| DESKTOP-SHELL-EXTERNAL-001 | preload/main IPC capabilities | typed external/file/OS capability boundary | U4D | desktop node/smoke | designed |
| DESKTOP-CUA-CONTROL-001 | private TSX/CSS | shared capability control primitive | U4D/U6 | desktop bridge | verified |
| DESKTOP-CUA-PIP-SHELL-001 | imperative DOM/CSS | React compact window primitives | U4D | PiP renderer | implemented |
| DESKTOP-CUA-PIP-STATUS-001 | private status overlay | shared status/feedback contract | U4D | PiP renderer | implemented |
| DESKTOP-CUA-PIP-ACTIONS-001 | text buttons/custom menu | IconButton + Menu + Tooltip | U4D | PiP renderer | implemented |
| DESKTOP-CUA-PIP-WINDOW-001 | layout/coordinator | preserve domain behavior, polish chrome | U4D | layout/smoke | designed |
| DESKTOP-CUA-PIP-THEME-001 | media-query Light/Dark | client-safe Theme snapshot | U4D/U13 | screenshots | implemented |
| DESKTOP-CUA-PIP-A11Y-001 | target/status shell name、named toolbar、ordered keyboard/menu、single live region automated | shared semantics + real AT evidence | U4D/release | focused `3/3` + renderer `23/23` + catalog `2/2`; manual AT open | implemented |
| DESKTOP-CUA-PIP-RECOVERY-001 | local status/retry branches | shared persistent recovery presentation, existing coordinator authority | U4D | renderer/coordinator/smoke | implemented |
| DESKTOP-CUA-NAVIGATION-001 | navigation intent store/Web hook | shared pending/retry semantics, preserve authority | U4D.6 | desktop bridge/node | implemented |
| DESKTOP-CUA-HOST-LAYOUT-001 | Web geometry reporter/layout selector | typed obstacle ownership and continuous relocation | U4D.6 | desktop bridge/layout | verified |
| SETTINGS-INTERFACE-CUA-PREVIEW-001 | private Settings checkbox row | Field + Switch + persistent warning | U7A/U4D.6 | desktop bridge/preferences | implemented |
| PLUGIN-CUA-PROVIDER-HEALTH-001 | daemon health snapshot + Plugin UI | single primary state + product repair action + Details | U10/U4D.6 | plugins/provider-health/Windows smoke | implemented |

## Current File Baseline

| File | Current | Target | Action |
|---|---:|---|---|
| `apps/desktop/renderer/computer-use-preview/main.tsx` | React bootstrap | retain below 150 lines | implemented |
| `ComputerUsePreviewApp.tsx` | React composition | compact-window composition only | implemented |
| `preview-controller.ts` / `preview-media-controller.ts` | extracted state/media ownership | retain and test safety invariants | implemented |
| `preview-view-model.ts` | 247 lines | pure domain view model | retained/tested |
| `messages.ts` | 128 lines | typed Desktop adapter catalog | retained/aligned |
| `styles/*.css` | 241 focused lines | 4 focused files + shared tokens | implemented；old 466-line file deleted |
| `DesktopComputerUseControlSlot.tsx` | 191 lines | adapter over shared primitive | implemented；command state remains adapter-owned |
| `DesktopComputerUseBridge.tsx` | 412 lines | controller hooks/services | split by command/lifecycle |
| `conversation-toolbar.css` | 375 lines | conversation toolbar only | Desktop capability CSS extracted |
| `apps/desktop/main/main.ts` | 1500+ lines | no new visual logic | extract composition separately |
| `computer-use/coordinator.ts` | 2200+ lines | domain only | no UI additions |
| `PersonalInterfaceSettingsPanel.tsx` Desktop preference | extracted focused component | shared Switch/InlineFeedback adapter | implemented in U4D.6 |

## Delivery Slice U4D

### U4D.1 Documentation And Guards

- register all Desktop/PiP Function IDs；
- add current files to CSS/Icon/Motion/Feedback matrices；
- add package-boundary guard for Electron imports；
- preserve existing Computer Use behavior tests as baseline。

### U4D.2 Compact Window Primitives

- implement compact window、header、status、IconButton and Menu adapters in `ui-react`；
- add Ling Light/Dark/custom theme fixtures；
- add minimum-width and keyboard tests。

Status：`implemented`。`@ling-stack/ui-react` 已包含 Button、IconButton、Tooltip、Menu、Spinner、
StatusIndicator、capability control 和 compact-window primitives；main window 与 PiP 已消费这些组件。

### U4D.3 Main-Window Capability Control

- replace private action buttons/spinner/feedback with shared primitive；
- keep bridge command semantics and session/revision guards；
- make failure feedback anchored and keep Header height stable；
- verify channel/normal/teammate placement。

Status：`verified`。三类会话已接入共享 capability control，旧 private action/feedback CSS 已删除；
bridge 20/20、dark-mode 2/2、Web build/typecheck/i18n 和 light/error trace 已通过。

### U4D.4 PiP Renderer Split And Migration

- extract media and state controllers before React conversion；
- mount React UI without moving release ACK/provenance logic into components；
- replace text controls/custom menu with standard icons and shared Menu；
- split CSS and remove color literals/private button state CSS。

Status：`implemented`。原 815 行 imperative renderer 已拆为 React composition、snapshot/command
controller 和 media controller；旧 466 行单文件样式已拆为 focused CSS。Desktop typecheck/build、
`ui-react` 13/13 和 PiP renderer 23/23 通过。

### U4D.5 Theme And Platform Sync

- add client-safe theme snapshot/revision to Desktop adapters；
- remove PiP `prefers-color-scheme` theme ownership；
- update main BrowserWindow bootstrap background；
- verify reduced transparency、forced colors and DPI/display changes。

Status：`implemented`。Web 通过窄 `appearance.reportTheme` capability 上报已解析主题，Desktop
main 校验白名单 token、生成 revision 并只向已授权 PiP renderer 广播；PiP 原子应用并忽略陈旧
revision。14 个场景、28 张 Light/Dark macOS ARM 基线覆盖 11 个权威状态、3 种 live 尺寸和
reduced motion，并通过 manifest/hash 复验。Windows、forced-colors、Narrator/NVDA 和 reduced-transparency 仍属于平台验收，
未完成前本切片不标记 `verified`。

### U4D.6 Remote Surface Coverage Follow-up

- migrate Desktop auto-show preference to shared Switch/Field and preserve session-only warning；
- productize Windows Cua Driver provider health into one primary state and repair action；
- add typed visible recovery for owned-daemon child exit/start timeout、resource missing and spawn failure；
- verify Open task missing/recreated/stale/failed owner-window paths；
- keep obstacle ownership and continuous relocation regression coverage；
- expand screenshot harness from 5 scenarios to all 11 authoritative PiP states in Light/Dark。

Status：`implemented`。远端能力与 UI 2.0 实现均保留；auto-show 已迁移到共享 Switch/InlineFeedback，
Windows provider health 已收敛为一个产品状态和折叠技术详情，四类启动失败进入 typed native
recovery，Open task/obstacle 回归通过，11-state Light/Dark 证据已生成。Web E2E 46/46、Desktop
Node 及 renderer 全套、截图 28/28 均通过。Windows 真实 provider、DPI/high contrast、真实 AT、
reduced transparency 和 native Dialog 实机证据仍未完成，因此本切片不标记 `verified`。

P6B.1 follow-up：Web geometry reporter 现在同时观察 workspace host 与受控 UI 2.0 overlay root；显式
Summary obstacle 从 Portal 规范化为 `popover`，并与 composer/dock/terminal 同时上报。Summary 与 Terminal
保持独立，`desktop-computer-use-bridge.spec.ts 20/20`、会话 panel 联合 `26/26` 通过。该修复不改变
Desktop command、session、provenance、media 或 PiP lifecycle 语义。

### U4D.7 Desktop Theme Pack Persistence Follow-Up

Status: `inventory / partial`. P7C.D has implemented the main-process repository at
`appData/themes/<themeId>/`, same-volume staging and atomic rename/swap, abandoned-staging recovery,
typed IPC/preload, main-side validation, Web/Desktop repository adapters, active/corrupt repair and
first-paint bootstrap. Repository, contract, IPC/preload and renderer lifecycle gates are complete;
renderer code still cannot choose or observe an absolute destination path.

`P7CD-T09` passed `19/19` on a real Apple Silicon macOS arm64 packaged application. The self-contained
bundle at `apps/desktop/release/evidence/theme-package-persistence/macos-arm64-20260726T151813Z`
contains 26 PNG screenshots, 14 stdout/stderr logs, zero runtime errors and six first-frame transitions.
Its candidate is unsigned, version `0.0.0` and built from a dirty worktree, so it is implementation
evidence rather than a formal release candidate.

The complete Function ID still requires real Intel macOS x64 and real Windows 11 x64 evidence for the
same lifecycle and first-frame contracts. Rosetta, Wine, WSL, Web IndexedDB tests, browser-injected
Desktop capabilities, token revision sync and PiP screenshots cannot close those platform gates.
Therefore `P7CD-T10` remains waiting, `P7CD-T11` is only partially reconciled, and
`DESKTOP-THEME-PACK-PERSISTENCE-001` must not move from `inventory / partial` to `verified`.

## CSS Migration

Target：

```text
apps/desktop/renderer/computer-use-preview/styles/
  index.css
  tokens.css       # aliases only, no Theme Pack literals
  shell.css        # frame/media/drag regions
  status.css       # layout only
  controls.css     # compact placement only

apps/web/src/styles/app/
  current-session-capability.css
```

- UI state、colors、focus、Menu and Button visuals come from `ui-react`。
- fake-source test artwork can retain fixture-only colors outside production theme budgets。
- final production PiP color literals target `0` except transparent BrowserWindow bootstrap values。

## Icon Migration

| Action | Current | Target |
|---|---|---|
| Open task | text | `ExternalLink` |
| Show/Hide | text + Eye icons in main only | `Eye` / `EyeOff` everywhere |
| More | text | `MoreHorizontal` |
| Reset position | text | `LocateFixed` |
| Screen settings | text | `MonitorCog` |
| Retry capture | text | `RotateCw` |
| Close window | text | `X` |
| Stop | text / Square in main | `Square` danger |

PiP uses the same fixed action mapping as Web。Logo and app icon remain protected。

## Motion Migration

| Current | Target |
|---|---|
| raw `120ms ease` live chrome | `--ling-motion-fast` + standard easing |
| local `spin 900ms` | shared Spinner |
| fake cursor drift | test fixture only, excluded from production behavior |
| window drag/resize | direct pointer/OS movement, no CSS transition |
| status rerender | stable layout, direct/fast fade |

## Feedback Migration

- main Header command failure：anchored persistent InlineFeedback owned by session control；
- PiP runtime/source status：persistent status overlay，not Toast；
- Stop failure：danger overlay + one retry，clears on retry/state/session change；
- permission required：warning overlay + Screen settings；
- successful Show/Hide/Stop acknowledgement：silent authoritative state update；
- raw IPC/provider/capture error：diagnostics only。

## Test Matrix

| Spec | Required coverage |
|---|---|
| `desktop-computer-use-bridge.spec.ts` | three conversation placements, 32px actions, header stability, command failure |
| `computer-use-preview-renderer.spec.mjs` | all states/actions/menu/keyboard/locale/theme |
| screenshot baseline | min/default/max + 11 states + reduced/forced modes |
| layout tests | obstacle avoidance, multi-display, DPI, clamp and persisted bounds |
| media/provenance tests | unchanged release ACK, identity, late stream cleanup |
| desktop smoke | main/PiP theme sync, crash isolation, Hide/Show/Stop |
| manual release | VoiceOver, Narrator/NVDA, TCC, Windows high contrast |

## Evidence Paths

```text
evidence/desktop/shell/<client>-<viewport>-<theme>-<state>.png
evidence/desktop/computer-use-control/<surface>-<state>.png
evidence/desktop/computer-use-pip/<platform>-<size>-<theme>-<state>.png
evidence/desktop/theme-package-persistence/metadata.md
apps/desktop/release/evidence/theme-package-persistence/<platform>-<arch>-<timestamp>/
```

The Theme Pack metadata file is the lightweight documentation index. Candidate archives, executable
bytes, `app.asar`, logs and screenshots stay in the self-contained Git-ignored release evidence bundle;
large binaries are not copied into `docs`.

## Static Targets

```text
PiP production color literals                         0
PiP private generic button/menu visual implementations 0
Feature CSS Profile/Theme ID selectors                 0
Electron imports in ui-react/Web feature code          0
PiP production source files >500 lines                  0
Header failures that change header height               0
PiP action hit areas below 32px                         0
```

## Completion Gate

- Desktop main window、native recovery and PiP are registered in the full-product matrix；
- current-session control matches all three conversation surfaces；
- PiP uses UI 2.0 theme/icon/button/menu/motion/feedback contracts；
- all 11 visual states and 3 sizes have Light/Dark screenshots；
- macOS and Windows evidence cover DPI、high contrast/reduced transparency and keyboard；
- migration preserves every existing runtime/provenance/release safety test；
- oversized renderer files are split before further visual features are added。
