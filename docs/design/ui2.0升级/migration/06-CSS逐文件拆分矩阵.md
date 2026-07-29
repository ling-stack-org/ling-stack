# CSS 逐文件拆分矩阵

## Baseline

Web 基线为 42 个文件、49,418 行；2026-07-20 P7B.4 检查点为 78 个文件、45,231 行。
Desktop PiP 另有 focused renderer CSS。迁移规则：
先把通用 selector 移入 package，再移动领域布局，
最后删除旧文件。不能只复制到新文件后保留旧 selector。

| Current file | Lines | Target ownership | Slice | Final action |
|---|---:|---|---|---|
| `base.css` | 360 | preflight + foundation tokens + built-in Theme Pack migration + app shell base | U1/U4 | split, delete old |
| `forms.css` | 1 -> deleted | none | U3/U13 | completed T13-H；empty placeholder and root import removed |
| `navigation.css` | 4 | live generic `nav` grammar only | U3/U4/U13 | T13-O.17 moved Sidebar-specific navigation baseline and deleted dead brand family；retain until remaining semantic nav consumers are audited |
| `page-shells.css` | 80 | ui data-display/PageShell | U1/U4 | move, delete old |
| `operation-states.css` | 116 | remaining focused operation feedback/status | U1/U2/U13 | T13-P.2-D removed OperationEmptyState adapter family；shared EmptyState is direct owner |
| `shared/artifact-row.css` | 120 | shared ArtifactRow layout and presentation | U12/U13 | Runs/Approvals/Inspector/External Work shared owner；T13-O.12 restored omitted grid/padding/truncation/action wrap；focused no-overlap + selected `49/49` |
| `workspace.css` | 573 | `features/workspace/*` | U5/U13 | T13-P.4 removed the zero-emitter readiness family；T12.1d removed the final aggregate input/textarea chrome and focus owner；FirstRun/provider focused owners remain protected |
| `conversation-home.css` | 83 | remaining normal conversation empty-state compatibility | U6B/U13 | P6B.2/P6B.3 moved Feed/Composer/Dock/page shell owners out；delete after empty-state compatibility migration |
| `runs.css` | 8 + eight focused owners (813) | `features/runs/*` | U12/U13 | import-only manifest；Timeline/Event log/detail/list owners focused，aggregate Runs selectors removed |
| `media.css` | 779 -> deleted | `features/media-jobs/*` | U11 / P10.1 | completed；focused list/detail/shell owners only |
| `media-job-detail.css` | 91 -> deleted | `features/media-jobs/detail.css` | U11 / P10.1 | completed；old selector owner removed |
| `media-create-dialog.css` | 115 -> deleted | ui Dialog/Field + focused media create layout | U2/U11 / P10.1 | completed；shared Dialog chrome + 58-line domain grid |
| `media-production.css` | 705 -> deleted | `features/media-production/{shell,project-scene,dialogs}.css` | U11 / P10.2 | completed；workspace/project/scene/delete geometry has focused owners |
| `media-production-inspector.css` | 550 -> deleted | `features/media-production/inspector.css` | U11 / P10.2 | completed；shared InspectorSection/control chrome remains package-owned |
| `media-production-canvas-first.css` | 380 -> deleted | `features/media-production/canvas.css` | U11 / P10.2 | completed；React Flow domain geometry remains focused |
| `media-workflows.css` | 630 -> deleted | `features/media-production/workflow.css` | U11 / P10.2 | completed；library/connection/import/mapping geometry has one owner |
| `media-production-priority-refinement.css` | 173 -> deleted | `features/media-production/{shell,canvas,inspector}.css` | U11 / P10.2 | completed；priority patch layer removed |
| `profile.css` | 387 | standalone Profile page + legacy standalone heatmap | U12/U13 | standalone name uses shared Field/Input；handle is read-only text；continue standalone split |
| `profile-settings.css` | 301 / target <= 360 | Settings identity、summary and stable geometry | U7A.2 | focused owner verified；do not add activity/crop selectors |
| `profile-settings-activity.css` | 127 / target <= 220 | Settings heatmap、streak、skill layout | U7A.2 | focused owner verified；shared controls stay package-owned |
| `profile-crop-dialog.css` | 75 / target <= 190 | avatar crop stage/range/domain geometry | U7A.2 | focused owner verified；Dialog chrome/overlay stay package-owned |
| `global-toast.css` | 102 | ui feedback/toast-loading | U2 | completed P1C: moved to package focused CSS, old file deleted |
| `automations.css` | 1,466 -> 5 | `styles/automations/*` import-only manifest | U2/U10/U13 | P9 split complete；T13-O.20 保持 facade 只导入 focused owners，不恢复 aggregate visuals |
| `automations/page.css` | 113 / delta +2 / target <= 140 | Automations root/page/header/main authoritative geometry | U10/U13 / T13-O.20 | `111 -> 113` only for root geometry；shared primitives own controls/rows/Dialog/Inspector chrome；focused `6/6`、legacy `2/2`、broad `149/149` |
| `mcp.css` | 491 -> deleted | none；shared chrome + focused MCP owner | U8 / P7B.1 | completed |
| `plugins.css` | 601 | `features/plugins/*` | U10 | split table/drawer/install |
| `providers.css` | 2354 -> 1 -> deleted | `features/model-workbench/*` + shared controls | U3/U10/U13 | completed T13-H；empty migration marker removed |
| `settings.css` | 371 -> deleted | none；50-line Settings content chrome + focused Archived owner retain live geometry | U7/U8/U13 | completed T13-O.1；71/71 selected regression and static gates |
| `settings-shell.css` | 211 / target <= 220 | Settings fullscreen、navigation、content scroll and responsive desktop boundary | U7A.1 | focused owner verified；do not add section visuals |
| `settings-content-chrome.css` | 50 / target <= 100 | Settings-scoped legacy panel title and embedded MetaRow chrome only | U13 / T13-O.1 | keep focused at original cascade position；must only shrink as embedded pages migrate |
| `settings-workspace-tools.css` | planned / target <= 140 | Settings embedded tool boundary、min-size、scroll and overflow containment only | U7B.5 | add focused owner；zero color/transition/keyframe preferred；do not style Model/Teammates/Council internals |
| `settings-interface-preferences.css` | 146 / target <= 240 | Appearance、Language、Desktop section layout and 1280 containment | U7A.4 | focused owner verified；ThemePicker/control chrome stay package-owned |
| `settings-external-work.css` | 206 / target <= 260 | External Work section、form、detail、summary and 1280 containment | U7A.5 | focused owner verified；shared control/Dialog visuals stay package-owned |
| `settings-mcp-tools.css` | 387 / target <= 400 | MCP section、server/tool row、editor field grid and 1280 containment | U7B.1 | focused owner verified；shared control/Dialog/Menu/Collapsible visuals stay package-owned |
| `settings-skill-library.css` + subfiles | 975 / each file <= 400 | Skill shell、registry、Inspector、Evolution and Dialog domain layout | U7B.2 | focused owner verified；shared control/Dialog/Table/Toast visuals stay package-owned |
| `settings-archived-items.css` | 178 / target <= 360 | Archived surface、Toolbar、Search、List、DataRow and Dialog domain geometry | U7B.3/U13 | T13-O.1 absorbed the five live panel declarations before aggregate deletion；shared controls/Dialog/Feedback stay package-owned |
| `settings-startup-diagnostics.css` | 398 / target < 400 | Startup header/issues/details and Run Diagnostics toolbar/list/detail domain geometry | U7B.4 | focused owner verified；shared controls/DataRow/Inspector/Feedback visuals stay package-owned |
| `settings-permissions.css` | 388 | `features/settings/default-authorization.css` | U7 | keep focused, tokenise |
| `settings-diagnostics.css` | 27 -> deleted | none | U8 | completed dead-file removal；P7B.4 final owner is `settings-startup-diagnostics.css` |
| `settings-interactions.css` | 60 | remaining Settings interaction compatibility | U2/U7 | P7B.4 removed Run Diagnostics owners；continue split, delete old |
| `settings-skill-editor.css` | 351 -> deleted | Skill editor domain geometry moved into focused Skill Dialog owner | U8 / P7B.2 | completed |
| `approvals.css` | 6 + six focused owners (579) | `features/approvals/*` | U12/U13 | import-only manifest；Inbox/Card/Inline owners focused，aggregate Approvals selectors removed |
| `work-board.css` | 698 | `features/work-board/*` | U12 | split list/inspector |
| `layout.css` | 455 | AppShell + remaining Avatar/Memory/Runtime compatibility layout | U2/U4/U13 | T13-P.4 removed dead runtime branches；T12.1d removed raw-control radius branches while preserving scoped `channel-path-field` and runtime owners |
| `conversation-message-frame.css` | 27 | Web feed/group/day-separator/mention boundaries only | U6/U13 / T13-O.7/O.21/O.27 | generic MessageRow/Bubble/Action visuals released to package；surface adapters must not restore shared frame chrome |
| `channel-message-transcript.css` | 438 / target <= 460 | Channel row identity/alignment、full-width AI replies、Turn/Transcript/status/preview and footer placement | U6A/U13 / T13-O.27 | focused owner；no package Action/Button chrome、color literal、Theme selector or global Input rule；focused ordinary/capture `3/3` |
| `teammates.css` | 946 -> deleted | none；existing focused Teammates owners + management shell + shared Avatar + private root + Message Frame | U9/U13 / T13-O.21 | completed；legacy file/import/positive writer refs `0`，不得恢复 aggregate facade |
| `teammate-management-shell.css` | 59 / target <= 120 | top-level management workspace/page/header and Settings return geometry | U9/U13 / T13-O.21 | token-only authoritative shell owner；no domain tab visuals or shared control chrome |
| `shared/teammate-avatar.css` | 19 / target <= 80 | cross-domain image Avatar base contract | U4/U5/U6/U9/U13 / T13-O.21 | unique Avatar base writer；54px default、34px compact、circle/object-fit/border/fallback；Sidebar/Channel/Council/Profile/management/private and Theme Pack evidence passed |
| `teammate-management-list.css` | 283 | AI teammate management list shell、toolbar、custom row slots、bounded scroll and responsive geometry | U9 / P8.1a | focused owner verified；shared control chrome stays package-owned；must not absorb Default roles/create or detail-tab selectors |
| `teammate-management-role-catalog.css` | 197 | Default roles panel、role rows、role-template Skill preview、bounded catalog scroll and responsive management grid | U9 / P8.1b-P8.1e | focused owner verified；P8.1e moved borrowed Skill preview selectors here；shared Button chrome stays package-owned |
| `teammate-management-role-detail.css` | 308 / target <= 360 | Portal Role Detail body、Advanced、Meta、Prompt、Workflow and footer containment | U9/U13 / T13-O.10 | aggregate target zero；token-only owner；focused `3/3`、Create `5/5`、selected `40/40 + 117/117`、three original-size screenshots |
| `teammate-management-create.css` | 325 | create Dialog geometry、role/custom forms、avatar controls and responsive body/footer containment | U9 / P8.1b | focused owner verified；shared Dialog/Form/Button chrome stays package-owned |
| `teammate-management-create-progress.css` | 135 | seven-step progress summary/list and semantic state placement | U9 / P8.1b | focused owner verified；domain events remain outside CSS |
| `teammate-management-settings-shell.css` | 265 | single-teammate Header、navigation、content/summary columns and scroll boundaries | U9 / P8.1c-P8.1e | focused owner verified；Model/Skills only register content owners；later Tabs reuse shell without appending domain visuals |
| `teammate-management-profile.css` | 182 | Profile identity、avatar actions、lifecycle、advanced persona and responsive containment | U9 / P8.1c | focused owner verified；shared controls/crop/feedback chrome stay package-owned |
| `teammate-management-model.css` | 113 | Model assignment heading、summary rows、repair/action placement and responsive containment | U9 / P8.1d | focused owner verified；shared form/status/feedback/button chrome stays package-owned |
| `teammate-management-skills.css` | 390 | Skills summary、toolbar、DataRow domains、advanced binding、Import/Drawer/Archive domain geometry and responsive containment | U9 / P8.1e | focused owner verified；shared controls/DataRow/status/feedback/overlay/motion chrome stays package-owned |
| `teammate-management-permissions.css` | 217 | read-only capability ceiling、policy requirement details、Workspace default preview and responsive containment | U9 / P8.1j | focused owner verified；zero color literal/`!important`/theme selector/`transition: all`/private keyframe/`.ling-ui-*` dependency |
| `teammate-management-mcp.css` | 332 / target <= 400 | AI Teammate MCP server/tool rows、selection、details、local state placement and nested search containment | U9/U13 / T13-O.2/T12.1b/T12.1d | explicit checkbox owner；720px container stacks identity/actions；server/tree collision guard；duplicate owner/forbidden scan zero |
| `teammate-private-header.css` | 212 | Teammate private Header、Search、Status、Summary placement and private role label | U6C.1/U13 | T13-O.10 moved the cross-consumer role label branch here；shared controls stay package-owned，P6C.2/P6C.3 must not append Feed/Dock selectors |
| `teammate-private-feed-composer.css` | 235 | Teammate private root grid、chat-mode、Feed、message attachment/feedback、Composer geometry | U6C.2/U13 / T13-O.21 | `208 -> 235` to absorb private workspace/chat-mode root only；Channel width and semantic tokens only，Dock page selectors remain outside |
| `teammate-private-dock.css` | 247 | Teammate private Context、Activity and Dock domain page layout | U6C.3 | keep focused；shared shell/motion stays conversation package-owned，management selectors remain outside |
| `council-settings-archive.css` | 314 | Council Settings/Lifecycle/Archive/Danger domain geometry | U9 / P8.2e | focused owner verified；shared controls/Dialog/Feedback/motion stay package-owned |
| `councils.css` | 45 -> deleted | none；Council detail skeleton moved to List/Health owner, Members/Channels import directly | U9/U13 | completed T13-L；root facade removed after Council focused `36/36` |
| `components.css` | 1717 | remaining feature compatibility families and cross-domain legacy owners | U1-U13 | T13-P.4 removed readiness/runtime/check/policy dead branches；T12.1d deleted every aggregate input/textarea default/focus/disabled/theme branch；focused owners remain protected |
| `runs/intervention-row.css` | 126 / target <= 140 | actionable/read-only intervention row、details、long-copy internal scroll、actions and responsive geometry | U12/U13 / T13-O.26 | focused owner；no package-private selector or color literal；ordinary/capture `3/3`、selected `36/36`、broad `48/48` |
| `shared/conversation-summary.css` | 279 / target <= 360 | shared Runs Summary Row、Channel Summary shell、three-conversation environment/context/progress content | U6/U12/U13 / T13-O.13 | token-only owner；dead queue item family zero；focused `9/9`、selected `152/153 + exact 2/2`、15 original-size screenshots |
| `shared/conversation-work-cell-activity.css` | 720 / target <= 720 | shared WorkCell Activity、Details、rows、CommandBatch、shell command、inline change preview、evidence links and WorkCell motion | U6/U12/U13 / T13-O.14 | token-only owner；15 dead rules / 16 branches deleted；focused `5/5`、selected `6/6`、File Diff `4/4`、six original-size screenshots |
| `shared/conversation-work-cell-shell-artifacts.css` | 690 / target <= 700 | shared WorkCell root/Operation Shell、Artifact/Reference、changed group、hover preview、Open With adapter and Channel turn geometry | U6/U12/U13 / T13-O.15 | token-only owner；25 dead rules / 30 branches deleted；focused `3/3`、combined `12/12`、broad `147/147`、five screenshots |
| `channel-activity-work-thread.css` | 556 / target <= 600 | Channel Activity shell、Filters、Drilldown、Triage and disabled Work Thread visual specimen | U6A/U13 / T13-O.16 | token-only owner；4 dead rules + 1 mixed branch deleted；focused `2/2`、Channel Activity `7/7`、Runtime/Dark/Input `25/25`、seven screenshots；Work Thread business chrome remains disabled |
| `channel-activity-controls.css` | 19 / target <= 80 | post-strict native input containment for Activity and Work Thread search shells | U5/U13 / T12.1b | 34px shell / 36px legacy conflict closed；focused Input `4/4` and Dark screenshot |
| `shared/conversation-evidence.css` | 309 / target <= 360 | shared Channel/Teammate/Runs Evidence disclosure、source summary、bundle/status/link/code containment | U6/U12/U13 / T13-O.11 | token-only owner；source/dead target zero；focused `3/3`、consumer regression `7/7 + 4/4 + 1/1`、three original-size screenshots |
| `shared/conversation-file-diff.css` | 256 / target <= 270 | shared FileChange evidence、DiffFile summary、message diff files、DiffViewer line/fold baseline | U6/U12/U13 / T13-O.12 | 43 live/dead zero；four adapter overrides registered；focused `4/4`、selected `49/49`、four original-size screenshots |
| `conversation-toolbar.css` | 202 | shared Header Search、summary、dock、terminal layout | U5/U6 | P5.1 owns Toolbar/Button/Badge in package；P6B.1 owns shared Search containment；continue split, delete old |
| `normal-conversation.css` | 87 | Normal Header and page grid compatibility | U6B/U13 | P6B.3 moved Dock/page-shell owner out；keep stable Header geometry, merge/delete during final compatibility cleanup |
| `normal-conversation-feed-composer.css` | 374 | Normal Feed、message row、Composer、model/thinking Menu domain layout | U6B.2 | keep focused；generic primitive visuals remain package-owned，P6B.3 must not append Dock selectors |
| `normal-conversation-dock.css` | 218 | Normal Dock/page shell/domain detail layout | U6B.3 | keep focused；package controls and Channel selectors remain outside this owner |
| `packages/conversation-ui-react/styles/toolbar/conversation-toolbar.css` | 81 | package Toolbar geometry and visual states | U5/U6 | keep focused；public frame semantics live in component markup, not Feature CSS |
| `packages/conversation-ui-react/styles/blocks/message-frame.css` | 235 / target <= 250 | shared MessageRow/MessageBubble root、avatar/content/meta、own/peer/system/blocked/pending and reduced motion | U6/U13 / T13-O.27 | package `ling.conversation` owner；stable root/avatar attributes；no Web domain import |
| `packages/conversation-ui-react/styles/feedback/message-action-bar.css` | 146 / target <= 180 | 32px actions、hover-focus/always/critical、selected/danger/disabled/loading、coarse pointer/reduced motion | U6/U13 / T13-O.27 | shared Radix Tooltip；no pseudo/data Tooltip writer；package tests `17/17` |
| `packages/conversation-ui-react/styles/blocks/message-body.css` | 580 / target <= 650 | shared Markdown/GFM/table/task-list/code/Mermaid/KaTeX message body presentation | U6/U13 / T13-O.3 | `ling.conversation` owner；package `10/10`、body `3/3`、three feeds `11/11` |
| `shared/conversation-terminal-report.css` | 271 / target <= 360 | shared Terminal Report outcome、rows、participants、file references and tooltip presentation | U6/U13 / T13-O.6 | sole owner for 22 class roots；source target zero、three conversations `3/3`、console/pageerror/overflow green；six preserved literal exceptions |
| `shared/conversation-artifact-preview.css` | 319 / target <= 360 | shared text/image Artifact Preview、drawer/lightbox geometry and four image compare modes | U6/U12/U13 / T13-O.8 | source target zero；focused `2/2`、existing Channel/Runtime `2/2`、focus/containment/reduced-motion/console/overflow green；forbidden/color scan zero |
| `shared/conversation-runtime-feedback.css` | 240 / target <= 360 | shared Status/Guidance layout、tokens、row containment and action placement | U6/U13 / T13-O.9 | aggregate baseline zero；shared primitives own control/Menu chrome；package `12/12`、focused `2/2`、full Channel/Teammates `126/126`；forbidden/color/z-index scan zero |
| `channel-header.css` | 189 | Channel Header grid、Search containment、Settings/Environment utility header | U6A | P6A.1/P6A.4 owner；keep focused，panel content stays separate |
| `channel-settings.css` | 545 | Channel Settings tabs、five panels、main grid and responsive containment | U6A | P6A.4 owner；keep focused，shared controls stay in package |
| `channel-overlays.css` | 352 | Channel rename/governance/in-feed approval overlay geometry and semantic states | U6A/U13 | Approval reason uses shared Field/Textarea；focused CSS owns placement only；keep focused |
| `channel-right-dock.css` | 4 | focused Dock domain CSS import manifest | U6A/U13 | O.25 adds shell import first；keep import-only |
| `channel-right-dock/shell.css` | 161 / target <= 180 | Channel workspace grid、Dock frame、panel motion、resize handle、desktop width、protocol/inspector adapters | U6A/U13 / T13-O.25 | token/layout-variable owner only；package keeps Header/Body/background/control chrome；focused `3/3`、selected `26/26`、broad `125/125` |
| `channel-right-dock/plans.css` | 128 | plan list、lineage and detail domain layout | U6A | P6A.4 owner；keep focused |
| `channel-right-dock/review-details.css` | 604 | review/detail/code preview domain layout | U6A | P6A.4 owner；split before 800 lines if expanded |
| `channel-right-dock/workspace-changes.css` | 257 | workspace file tree、badges、diff containment | U6A | P6A.4 sole badge breakpoint owner |
| `channel-feed-composer.css` | 467 | Channel conversation column、Feed scroll owner、virtual rows、Channel feedback slots and Channel Status final override | U6A/U13 | P6A.2/P6A.4 approval strip owner；T13-O.9 moved active-status consumer chrome here；generic Status/Guidance and Composer visual stay shared/package-owned |
| `channel-runtime-diagnostics.css` | 128 / target <= 180 | Runtime Diagnostics shell、MetaRow containment、status placement and narrow Dock geometry | U6A/U12/U13 / T13-P.3-S/X | typed status presentation + shared StatusIndicator；双主题 formal evidence 与 MetaRow 原尺寸检查完成 |
| `channel-task-environment.css` | 454 | Channel task creation/detail、Environment data rows、Commit Dialog layout | U6A | added P6A.3；keep focused，shared primitive visuals stay in package |
| `channel-workflow-preview.css` | 178 | Workflow conversion Dialog content layout | U6A | P6A.3 owner；P6A.4 overlay regression passed |
| `channel-execution-proposal.css` | 524 / target <= 650 | Channel execution proposal、requirement shaping、collaboration details、edit form and compact workflow card presentation | U6A/U13 / T13-O.4/O.10/T12.1c | Seven text controls use shared Field/Input/Textarea；no private shared selector or control chrome |
| `channel-proposed-plan.css` | 80 / target <= 120 | Proposed Plan message states、actions、busy/error and long-content containment | U6A/U13 / T13-P.3-F/L | `.proposed-plan-*` focused owner；aggregate source family zero；五张 formal evidence 完成 |
| `channel-right-dock/brief-editor.css` | 13 / target <= 80 | Channel Brief editor layout/actions only | U6A/U13 / T12.1c | Five shared Textarea controls；legacy `.brief-editor` removed from aggregate CSS |
| `channel-workflow-context.css` | 372 / target <= 500 | Context Source Detail、Context Packet and Workflow Context presentation | U6A/U13 / T13-O.5 | sole owner for 65 selectors；source target zero、Channel/Dark `5/5`、console/pageerror/overflow green |
| `channel-workflow-status.css` | 13 / target <= 80 | Workflow、Step and linked Workflow/Run StatusIndicator placement | U6A/U13 / T13-P.3-U/W | typed presentation owns label/tone；旧 Workflow StatusBadge calls 和 aggregate selector 归零；双主题 formal evidence 完成 |
| `creation-dialogs.css` | 576 | ui Dialog/Field + feature-specific create flows | U2/U3 | split, delete old |
| `channel-team-metrics.css` | 112 | workspace/Council metrics | U5/U9 | merge into focused feature |
| `strict-console.css` | 335 | remaining legacy Theme/client blankets with explicit focused-surface exclusions | U3-U13 | T13-P.2-B released obsolete text-input repaint and six dead leaves；background/button/active/status blankets remain audited no-go |
| `app/sidebar-layout.css` | 737 / target 620-740 / max 800 | expanded AppShell Sidebar shell、navigation、sections、rows、branch form/list and fixed footer | U4/U13 / T13-O.17 | token-only focused owner；focused + existing `12/12`、broad `149/149`、ten screenshots；must not absorb rail motion/responsive duplication |
| `sidebar.css` | 138 | Sidebar variables/keyframes、expanded compatibility and non-rail responsive layout | U2/U4/U13 | T13-P.2-C removed dead compatibility；T13-P.3-H/K retained the 240/48、900/901 and reduced-motion geometry contract |
| `app/sidebar-rail-sections.css` | 175 / max 240 | 48px compact launcher rail、three fixed section launchers、primary actions、Settings footer and local state | U4/U13 / T13-O.18/P.2-C | object list/preview/stack paths removed；collapsed owner unique；Sidebar focused `19/19` |
| `app/full-access-confirmation.css` | 22 | AppShell permission Dialog content only | U4 | keep focused, tokenised |
| `app/sidebar-ui2.css` | 153 | Expanded Sidebar Menu/IconButton、public Button slot variables、domain avatar、section/list state 和 local feedback layout | U4/U13 | collapsed child rules removed；rail state 仅由 `sidebar-rail-sections.css` 持有 |
| `app/connection-status.css` | 34 | AppShell daemon health feedback placement | U4 | keep focused, tokenised |
| `action-menus.css` | 87 -> deleted | shared Radix Menu | U2/U10/U13 | completed T13-H；ActionMenuItem reference count reached zero |
| `model-workbench.css` | 589 -> 1 -> deleted | `features/model-workbench/index.css` | U10/U13 | completed T13-H；root import now points directly to focused index at the same cascade position |
| `features/model-workbench/*` | 632 / delta +20 / contract max +40 | Model Workbench surface/toolbar、four-column table、Editor、feedback and responsive containment | U10/U13 / T13-O.19 | token-only focused cluster is the real owner；75 Provider/Model roots live、dead `0`、forbidden scan `0`、Model `25/25` + Settings/Dark `26/26` + broad `149/149` |
| `select-controls.css` | 182 -> 10 -> 4 -> deleted | none；shared Select owns control chrome，feature CSS owns domain layout | U3/U13 | T13-P.3-A/E 依次迁移 Settings 与 Channel consumers；T13-P.3-N/R 关闭最终 `0/0` facade 并删除文件/import |
| `packages/ui-react/styles/navigation/collapsible.css` | 45 | shared Collapsible geometry、motion and reduced-motion contract | U4 | keep focused in package |
| `packages/ui-react/styles/theme/theme-picker.css` | 343 | shared ThemePicker、ThemeOption and isolated package preview chrome | U7C | keep focused in package |
| `packages/ui-react/styles/theme/theme-studio-preview.css` | 424 / target <= 500 | synthetic four-surface viewport、exact scale、protected Settings/Dialog geometry | U7C.2 | keep focused；production Settings page layout must not enter this file |
| `apps/desktop/renderer/computer-use-preview/styles.css` | 466 | ui compact primitives + focused PiP shell/status/control layout | U4D | split, delete old |

## Critical Large Files

### `components.css`

按 selector family 拆为：conversation shell/feed、composer、operation/work cell、artifacts、
preview/drawer、workspace toolbar/panels、共享 overlay、controls、legacy layout。通用部分进入
`ui-react`，会话部分进入 `conversation-ui-react`，业务部分回到对应 feature。U13 删除文件。

### `teammates.css`

T13-O.21 已完成删除。管理 Shell、列表、Role/Create、Settings Tabs、MCP、private Header/Feed/Dock 分别由
focused owner 持有；跨域图片头像由唯一 `shared/teammate-avatar.css` 持有，共享 day separator 归
`conversation-message-frame.css`。legacy file/import/positive writer 命中为 `0`，后续不得恢复 facade。

### `settings.css`

只保留 `app/settings-shell.css` 的导航、内容 grid 和滚动责任。Profile、Personalization、
External Work、Skill 和 Archive 已进入独立 section CSS；Diagnostics 与 embedded sections 继续迁出；通用表单和 overlay
进入 ui-react。

### `providers.css`, `layout.css`, `sidebar.css`, `strict-console.css`

这些文件中的 Button、Menu、Tooltip、Popover、Status、Field 和主题覆盖全部删除。领域布局
进入各自 focused 文件；`strict-console.css` 不保留为全局覆盖层。

### Desktop Computer Use CSS

`apps/desktop/renderer/computer-use-preview/styles.css` 拆为 `shell.css`、`status.css`、
`controls.css` 和 alias-only `tokens.css`。其中现有 43 个颜色字面量、Light/Dark
`prefers-color-scheme`、private button/menu/spinner/focus 样式全部删除或提升到 `ui-react`。
媒体 framing、drag/no-drag、compact overlay positioning 留在 Desktop focused CSS。

`conversation-toolbar.css` 中 `.desktop-computer-use-*` selector 拆到
`apps/web/src/styles/app/current-session-capability.css`；Button、IconButton、Spinner、Tooltip 和
InlineFeedback 视觉进入 package。迁移后该文件不再承担 Desktop capability primitive。

### Theme Selector Extraction

- `base.css` 的 Light/Dark root variables 迁入 `ling-light` / `ling-dark` built-in Theme Pack manifest。
- `components.css`、`strict-console.css`、`profile.css`、`teammates.css` 和 model CSS 的
  component-level theme selectors 转为 semantic tokens，不迁移到新 Feature selector。
- 主题导入的 runtime CSS variable owner 不接收 selector，只写入 allowlist 变量。
- U13 后新增 Theme Pack 不修改本矩阵中任何 Feature CSS。
- PiP 不再通过 `prefers-color-scheme` 或本地 Light/Dark literal 决定主题；它消费 Desktop
  renderer Theme snapshot 和 compact semantic aliases。

## Migration Proof

每移动一个 family，PR 必须记录源文件行号范围、目标文件、删除行数、保留理由、
涉及 semantic/Theme Pack token 和对应 E2E。
仅新增目标 CSS 而没有删除源 selector，不得标记完成。

P6A.1 proof：`channel-header.css` 新增 128 行 focused Header/Search layout；`layout.css` 删除旧
`.channel-header/.channel-title-line/.channel-header-actions` family，`components.css` 删除重复的
`.task-workbench-header/.channel-title-area/.channel-title-line` layout family。新文件只使用 semantic
token，没有新增颜色字面量、`!important`、Theme Pack ID selector 或 `transition: all`。

P6A.2 proof：新增 230 行 package-owned `conversation-composer.css` 和 305 行 focused
`channel-feed-composer.css`；`components.css` 从 16,386 行降至 15,801 行，并删除约 984 行旧
Feed/Composer/permission/token selector diff。package 只拥有 Composer shell、tokenized input 和权限菜单；
Web focused 文件只拥有 Channel column、scroll、virtual row 和 feature feedback placement。两份新 CSS
都使用 semantic token，没有新增颜色字面量、`!important`、Theme Pack ID selector 或
`transition: all`。保留的 active stream、status strip 和消息内容 selector 仍有真实 owner，进入后续
WorkCell/Task/Environment 或 U13 逐引用清理，不能为追求行数盲删。

P6A.3 proof：新增 454 行 focused `channel-task-environment.css` 与 178 行
`channel-workflow-preview.css`，分别拥有任务/Environment 和 workflow preview feature layout；共享
Field/Button/DataRow/Inspector/Segmented/Feedback/Dialog 视觉仍由 package 所有。相对 P6A.2 检查点，
`components.css` `15,801 -> 14,998`，删除旧 Task card/permission/Environment card wall/commit overlay
和 workflow preview selector；`layout.css` `1,920 -> 1,894`；
`runs.css` 删除 341 行无生产 owner 的 `ChannelTaskWorkspace` family；`workspace.css` 删除 51 行会覆盖
共享 InlineFeedback 的旧 run-repair 规则。focused CSS 颜色字面量、`!important`、Theme Pack ID selector
和 `transition: all` 均为 `0`。当前 Web CSS 为 52 个文件、47,687 行；后续 P6A.4 继续只减聚合文件。

P6A.4 proof：Settings 五 Tab 和 Dock domain 分别归 `channel-settings.css` 与
`channel-right-dock/{plans,review-details,workspace-changes}.css`，通用 Dock shell/launcher/list 继续归
conversation package。最后收口将 utility header family 从 `components.css` 迁入 `channel-header.css`，
Settings main grid 迁入 `channel-settings.css`，并删除 `components.css` 重复 workspace badge breakpoint。
`components.css` `11,457 -> 11,388`、`channel-header.css` `128 -> 189`、`channel-settings.css`
`540 -> 545`，Web CSS `46,020 -> 46,017`。focused 文件颜色字面量、`!important`、Theme Pack ID selector
和 `transition: all` 均为 `0`；package `40/40 + 10/10`、focused `7/7` 和静态门槛通过。

P4.1 proof：删除 `.sidebar-hover-tooltip` 19 行 legacy selector；共享 Menu/Tooltip/Button/Feedback
视觉由 package 所有，Web 新增 focused placement layout。

P4.2 proof：`sidebar.css` 删除 3 条对迁移后 `.sidebar-row-main` 子 span 的宽泛 display selector；
`sidebar-ui2.css` 为 72 行，只通过公开 Button CSS variables 设置 slot 几何，并只选择领域头像 class。
Feature CSS 中 `.ling-ui-button-leading/label/trailing` selector 为 0。

P4.3 proof：新增 45 行 package `collapsible.css`，统一 open/close、motion token 和 reduced motion；
Web 删除旧 unread/mention 硬编码绿色和 rail unstack/restack/item keyframes，`sidebar.css` 降至
1960 行。`sidebar-ui2.css` 只保留 Sidebar 领域布局和 shared primitive 的公开状态入口。

P4.4 proof：状态投影不写 CSS；semantic status column 的布局只进入 `app/sidebar-ui2.css`，
compact rail 显式隐藏该列并由 rail identity/section preview 保持稳定。`sidebar.css` 保持 1960 行，
没有因为 list state completion 继续增长。

P4.5 proof：Radix Menu 已无 `.sidebar-section-menu-popover/.open/.copy/.rich-*` legacy selector；
section action 的 expanded/open/compact 所有权迁入 `app/sidebar-ui2.css`。四个聚合文件合计删除
332 行旧 Sidebar menu/override CSS；focused 文件增加 22 行明确 owner，compact rail overlap 用浏览器
点击证据关闭。

P6C.3 proof：新增 247 行 `teammate-private-dock.css`，只拥有私聊 Context/Activity/DataRow/technical
Inspector 的领域布局；共享 Dock shell、launcher、Presence 和 resize 继续归 conversation package。
`teammates.css` `4,800 -> 4,735`、`sidebar.css` `1,850 -> 1,849`，旧 private Context/Dock selector family
已删除；总 Web CSS 为 66 文件、46,091 行。focused 文件颜色字面量、`!important`、Theme/Profile
selector、`transition: all` 和私聊 keyframe 均为 `0`。package `40/40 + 10/10`、focused `2/2`、selected
regression `78/78` 和七张原尺寸证据通过。

P7A.1 proof：Settings fullscreen、navigation、active item 和 content scroll selector family 进入 211 行
focused `settings-shell.css`；`settings.css` `3,137 -> 2,914`、`sidebar.css` `1,849 -> 1,816`。
`strict-console.css` 只增加 semantic Settings exclusions，`1,411 -> 1,416`，`styles.css` 增加 focused import。
新文件颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和 package-private
Button class selector 均为 0。Web CSS 为 67 文件、46,052 行；后续 section CSS 不得回填 Shell selector。

P7A.3 proof：Default Authorization 和 Personalization 的领域布局分别进入 48 行
`settings-default-authorization.css` 与 258 行 `settings-personalization.css`；shared DataRow、SegmentedControl、
Field、Select、InspectorSection、Toast 和 InlineFeedback 继续由 package 拥有视觉与交互。
`settings.css` `2,899 -> 2,656`、`select-controls.css` `182 -> 10`；单一调用方 `RichChoiceSelect` 及
`.rich-choice-*` selector family 已删除。两个 focused 文件的颜色字面量、`!important`、Theme/Profile
selector、`transition: all` 和 private keyframe 均为 `0`。当前 Web CSS 为 71 文件、46,039 行；P7A.4
不得把 Interface Preferences selector 回填到上述两个 owner。

P7A.4 proof：Interface Preferences 的 section、row、language grid 和 Desktop feedback placement 进入 146 行
`settings-interface-preferences.css`；ThemePicker visual/motion remains package-owned。`settings.css`
`2,656 -> 2,611`，单一调用方 `.theme-switcher/.language-switcher` selector family 已从 `base.css`、
`components.css`、`layout.css` 删除。focused 文件颜色字面量、`!important`、Theme/Profile selector、
`transition: all` 和 private keyframe 均为 `0`。当前 Web CSS 为 71 文件、46,076 行；package `41/41`、
focused `5/5`、selected `51/51` 和五张原尺寸证据通过。

P7A.5 proof：External Work section、form、detail、summary 和 1280 containment 进入 206 行 focused
`settings-external-work.css`；`settings.css` `2,611 -> 2,557`，旧 `.panel`、External Work action box/count/
form/detail alias 和 `SettingsMetaLine` 调用均归零。focused 文件颜色字面量、`!important`、Theme/Profile
selector、`transition: all`、private keyframe 和 package-private `.ling-ui-*` selector 均为 `0`。当前 Web CSS
为 72 文件、46,225 行；package `41/41`、focused `5/5`、selected `132/132` 和五张原尺寸证据通过。

P7B.1 proof：MCP section、server/tool rows、editor grid 和 1280 containment 进入 387 行 focused
`settings-mcp-tools.css`；491 行 `mcp.css` 删除，`settings.css` `2,557 -> 2,521`，旧 MCP page/sheet/
card/tool/details selector 不再有第二 owner。共享 Button、Dialog、Menu、DataRow、Status、Feedback、
Collapsible 和 Inspector 视觉继续归 package。focused 文件颜色字面量、`!important`、Theme/Profile selector、
`transition: all`、private keyframe 和 package-private `.ling-ui-*` selector 均为 `0`。当前 Web CSS 为
72 文件、46,085 行；package `41/41`、focused `5/5`、selected `34/34`、broader `139/139` 和六张原尺寸
证据通过。

P7B.2 proof：Skill shell、registry/table、Inspector/source history、Evolution queue 和 Import/Editor/Delete
Dialog 领域布局进入 975 行 focused owner，入口加五个 subfiles 且每个低于 400 行。`settings.css`
`2,521 -> 972`、`settings-interactions.css` `220 -> 190`，351 行 `settings-skill-editor.css` 和旧 Skill
selector family 已删除。共享 Input/Select/Button/Table/Dialog/Inspector/Toast chrome 继续归 package；focused
CSS 仅约束 32px 搜索 native input、action cell 和领域 geometry。颜色字面量、`!important`、Theme/Profile
selector、`transition: all`、private keyframe 和 package-private `.ling-ui-*` selector 均为 `0`。当前 Web CSS
为 76 文件、45,098 行；package `41/41`、focused `4/4`、ownership/import `7/7`、selected `27/27` 和六张
原尺寸证据通过。

P7B.3 proof：Archived toolbar/search/list/row/Dialog 领域布局进入 173 行
`settings-archived-items.css`；`settings.css` `972 -> 823`。当前 Web CSS 为 77 文件、45,123 行；
package `41/41`、focused `5/5`、existing `19/19`、selected `29/29` 和六张原尺寸证据通过。

P7B.4 proof：Startup/Diagnostics selector family 进入 398 行
`settings-startup-diagnostics.css`；`settings.css` `823 -> 662`，`settings-interactions.css` `190 -> 60`。
当前 Web CSS 为 78 文件、45,231 行；新 owner 的颜色字面量、`!important`、Theme/Profile selector、
`transition: all`、private keyframe 和 package-private `.ling-ui-*` selector 均为 `0`。

P7B.5 proof：新增 27 行 `settings-workspace-tools.css`，只拥有 embedded boundary geometry；颜色字面量、
`!important`、Theme/Profile selector、transition/keyframe 和 package-private selector 均为 `0`。删除
`SettingsWorkspaceToolsPanel.tsx` 与 `settings.css` 中约 226 行唯一 selector，`settings.css` `662 -> 436`。
Provider/Council/Teammate CSS 未因 wrapper 增加业务 selector；`model-workbench.css` `589 -> 617` 只补
right-sheet containment、reduced motion 和长列表 header non-shrink。当前 Web CSS 为 79 文件、45,061 行；
selected `88/88`、focused evidence `7/7` 和六张原尺寸证据通过。

P7C.1 proof：Theme Package toolbar、review、preview 和 1280 containment 由 193 行 focused
`settings-theme-packages.css` 唯一所有；`settings.css`、`components.css`、`base.css` 和 `layout.css` 不存在
第二套 theme-package selector。ThemePicker option/action chrome 与 motion 继续归 package owner。focused CSS
颜色字面量、`!important`、Theme/Profile ID selector、`transition: all`、private keyframe 和 package-private
`.ling-ui-*` selector 均为 `0`。当前工作树 Web CSS 快照为 66 文件、42,866 行，`settings.css` 保持 436 行；
package `45/45`、focused `5/5`、selected `83/83` 和六张原尺寸证据通过。

P8.1b proof：Default roles、role chooser、custom setup、avatar 和 seven-step progress 分别进入 `153/325/135`
行 focused CSS owner；`teammates.css` `4,344 -> 2,864`，`strict-console.css` 保持 `1,187`。迁移的 role/create/
wizard selector 在 `teammates.css`、`strict-console.css`、`components.css` 中剩余命中为 `0`。三个 focused
文件的颜色字面量、`!important`、Theme/Profile selector、`transition: all` 和 package-private `.ling-ui-*`
selector 均为 `0`。当前 Web CSS 为 84 文件、44,015 行；package `50/50`、focused `5/5`、selected
`35/35` 和五张原尺寸证据通过。

P8.1c proof：single-teammate Settings shell/Profile selector family 进入 `257/182` 行 focused owners；
`teammates.css` `2,864 -> 2,648`、`strict-console.css` `1,187 -> 1,186`。无调用方的
`.teammate-profile-form/.teammate-avatar-preview/.teammate-avatar-settings/.teammate-avatar-actions/
.teammate-settings-panel` 和旧 shell/nav/summary owners 已删除，legacy 剩余命中为 `0`。focused 文件的
颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和 package-private
`.ling-ui-*` selector 均为 `0`。当前 Web CSS 为 85 文件、44,165 行；package `50/50`、focused `6/6`、
Teammates `21/21`、selected `16/16` 和五张原尺寸证据通过。

P8.1d proof：Model assignment geometry 进入 113 行 `teammate-management-model.css`；Settings shell 只增加
2 行 Model content-owner registration，`257 -> 259`。旧 `.teammate-settings-grid/.teammate-config-card`
selector 已从 `teammates.css` 删除，`teammates.css` `2,648 -> 2,628`。focused owner 的颜色字面量、
`!important`、Theme/Profile selector、`transition: all`、private keyframe 和 package-private `.ling-ui-*`
selector 命中均为 `0`。当前 Web CSS 为 87 文件、44,340 行；package `50/50`、focused `6/6`、selected
`36/36` 和五张原尺寸证据通过。

P8.1e proof：Skills domain geometry 进入 390 行 `teammate-management-skills.css`；Settings shell 只增加 Skills
content-owner registration，`259 -> 265`；role template 的 Skill preview 进入 role-catalog owner，`153 -> 197`。
旧 workbench/table/inspector/binding/import selector family 从 `teammates.css` 删除，`teammates.css`
`2,628 -> 2,105`。当前 focused owner 的
颜色字面量、`!important`、Theme/Profile selector、`transition: all`、private keyframe 和 package-private
`.ling-ui-*` selector 命中均为 `0`；共享 Input/Select/Button/IconButton/DataRow/StatusIndicator/InlineFeedback/
EmptyState/Menu/Dialog/Drawer/InspectorSection 的视觉与 overlay motion 不复制到 Feature CSS。当前 Web CSS
快照为 88 文件、44,161 行；ui-react `50/50`、conversation UI `10/10`、focused `13/13`、selected `52/52`
和五张原尺寸证据通过。

P8.1j proof：Permissions domain geometry 进入 217 行 `teammate-management-permissions.css`；shared DataRow、
StatusIndicator、Badge、InspectorSection、InlineFeedback、Skeleton 和 Button chrome 继续由 package owner 管理。
focused CSS forbidden-selector/color scan 为 0；`TeammateWorkspace.tsx` 只增加 typed composition，权限解析继续
复用 Core resolver。focused `5/5`、selected `60/60` 和六张原尺寸证据通过。

P8.2e proof：Council Settings/Lifecycle/Archive/Danger geometry 进入 314 行
`council-settings-archive.css`；旧 Settings selector family 已从 `councils.css` 退出，聚合文件只剩 45 行
Council detail skeleton。两文件 class token 交集为 0；focused owner 的颜色字面量、`!important`、Theme/Profile
selector、`transition: all`、private keyframe、raw duration/easing 和 package-private `.ling-ui-*` 命中均为 0。
focused `7/7`、selected Council/Settings/Dark `66/66` 和六张原尺寸证据通过。

T13-D proof：`work-board.css` 仅保留五个 focused import，Work Board 页面和 Channel 投影由
`work-board/{page,toolbar,list,inspector,channel}.css` 唯一拥有；`strict-console.css` 的 21 个 Dark blanket
通过零 specificity public-root boundary 排除 `.work-board-page`、`.channel-work-board` 及其后代，不再命中
真实 Light/Dark 页面。迁移没有恢复旧 `article` 或第二套 Button/DataRow chrome；E2E helper 使用公开
DataRow/action。当前聚合快照为 `components.css=11,320`、`strict-console.css=1,139`、
`workspace.css=1,119`；focused/legacy `12/12`、selected `147/147` 和九张原尺寸证据通过。

T13-E proof：Approvals Inbox/Card/Inline Strip 由 `approvals.css` 六个 focused imports 唯一拥有；Channel
approval detail/status/reason 迁入 `channel-overlays.css`。`components.css`、`strict-console.css`、
`workspace.css` 的 Approvals 与旧 `inline-approval-panel/head` selector 命中归零，dead family 直接删除。
focused owner 的颜色字面量、`!important`、Theme selector、`transition: all` 与 private keyframe 命中为 0。
当前聚合快照为 `components.css=11,207`、`strict-console.css=1,108`、`workspace.css=1,089`；wrong-role
exact repeat `3/3`、focused Approvals + legacy + Channel overlay combined `18/18` 通过。

T13-F proof：Runs/Threads Timeline、assistant summary、raw events、event rows 与 detail summary 由
`runs/{timeline,event-log,run-detail}.css` 拥有；共享 Artifact 行进入 `shared/artifact-row.css`；Channel Runtime
summary 使用 `runtime-supervisor-meta` focused owner，不再借用 `run-evidence-grid`。三个聚合文件的目标 selector
命中归零，focused forbidden scan 为 0。当前聚合快照为 `components.css=10,986`、
`strict-console.css=1,056`、`workspace.css=870`；Runs/Runtime `26/26`、focused import split `7/7`、跨消费者
Approvals/External Work `19/19` 通过。

T13-G proof：Profile root 的 `strict-console.css` Dark compatibility entry 已删除；Settings Profile identity、
usage、name row 和 summary 使用公开 data contract，关键 E2E 不再依赖这些视觉 class。Standalone
`profile.css` 仍有真实 AppShell route owner并完整保留。原跨模块 Model Workbench stale locator exact repeat
`3/3`，最终 Profile/App/Dark/Feedback selected regression `32/32`；`strict-console.css=1,055`。

T13-I proof：`workspace.css` 删除 160 行 production-zero-reference selector，降至 710 行。随后 Terminal、
bottom panel 和 resize family 从 `components.css` 唯一迁入 355 行 `conversation-panels.css`，删除重复
`!important` 和私有 spinner keyframe；`components.css=10,710`，Web CSS 总量为 139 文件 / 40,319 行。
focused panels `6/6`、Summary continuous-visibility repeat `3/3`、Channel Terminal `1/1`、selected `63/63`
及静态门槛通过；源聚合 Terminal selector 与 focused forbidden scan 均为 0。

T13-L proof：45 行 `councils.css` facade 已删除。仍有生产引用的 Council detail Tabs/body/section skeleton
保持原值迁入 `council-list-health.css`，相同 body/grid 几何合并为一个 selector group；Members/Channels
focused owners 改由根入口在原 cascade 位置直接加载。生产 class 命中均保留，Council List/Create/Members/
Channels/Settings-Archive focused 回归 `36/36`；Web CSS 为 138 文件 / 40,311 行。未改 API、状态、IA、
Function ID 或 evidence 图片。

T13-M proof：`components.css` 删除 70 行 production-zero-reference `.teammate-council-actions/create-fields/
action-row/summary-actions/summary-mode/routing-note/summary-list/summary` 旧 family，不迁移；Create/Clone 和
Management List 继续由既有 focused owners 负责。`settings.css` 删除 37 行 production/CSS-zero-reference
`.runtime-runner-settings-panel/row/readiness/status-dot` family，不迁移。前者 Council focused `9/9`，后者
Settings/Dark `19/19`，两边 lint 通过；Web CSS 为 138 files / 40,204 lines。`teammates.css` 的同名前缀
compatibility selector 未在本切片盲删，留后续独立引用审计。

T13-N proof：四个互斥 aggregate owner 只删除全仓零引用 family。`components.css` 删除 50 行
`.activity-ops-disclosure/.activity-ops-panel` 主 family，并由主线程补删唯一剩余 4 行 descendant override，
完整 Activity/Channel 回归 `111/111`；`teammates.css` 删除 22 行旧 Council summary，Teammate/Council
`17/17`；`settings.css` 删除 28 行 compact details，External Work/Settings/Dark `24/24`；`layout.css`
删除 57 行 file/run-artifact family，Runs/Runtime `26/26`。四组 lint 和目标引用扫描均通过，Web CSS
`138/40,204 -> 138/40,043`。未修改 API、业务状态、测试源码、evidence 或 Desktop owner。

T13-O.1 proof：371 行 `settings.css` 已完整删除。Settings-scoped `panel-title/meta-row` live chrome 收敛为
50 行 `settings-content-chrome.css` 并保持原 root import cascade 位置；Archived Items 的 5 行 live panel
几何归入自身 focused owner。Plugin Manager 继续由既有 plugin shell 拥有，其余约 250 行零生产引用/重复
selector 不迁移。App/Settings/Plugin/Archived/Workspace Tools/Dark/Form 联合 `71/71`，typecheck/lint/i18n/
diff check 通过；Web CSS `138/40,043 -> 138/39,727`。未修改业务组件、API、Function ID 或 evidence。

T13-O.2 proof：`teammates.css` 的完整 `.teammate-mcp-*` family 迁入 328 行
`teammate-management-mcp.css`，源文件降至 1,435 行且目标命中为 `0`。focused owner 共 43 个规范化
selector；其他生产 CSS 的精确重复 selector、颜色字面量、`!important`、Theme selector 和
`transition: all` 均为 `0`。MCP/Settings MCP `7/7` 通过；Dialog Esc 首轮偶发时序失败后隔离 `3/3`
和完整复跑均通过，未修改或弱化测试。Light 1440 与 Dark 1280 实页 console/pageerror/横向溢出为零。

T13-O.3 proof：577 行共享消息正文 presentation 从 `components.css` 迁入 package-owned 580 行
`styles/blocks/message-body.css`，通过 `ling.conversation` layer 加载；Web aggregate 降至 10,009 行。
迁移覆盖 Markdown、GFM table/task-list、code/highlight、Mermaid、KaTeX 和 rich content，source aggregate
重复 root selector 与颜色字面量均为 `0`。conversation package `10/10`、三类正文 `3/3`、三类
Feed/Composer 双主题双视口 `11/11` 通过；console/pageerror/document overflow 均为零。O.2/O.3
完成后的 Web CSS 快照为 `139 files / 39,156 lines`；package CSS 不计入 Web source 行数。

T13-O.4 proof：24 个 `.channel-execution-proposal/.channel-proposal-*` 与 requirement-shaping class family
从 `layout.css 1,836 -> 1,620`、`components.css 10,009 -> 9,590` 收敛到 511 行
`channel-execution-proposal.css`；root import 位于原最终生效的 components layer 之后，保持 cascade。
旧 owner 目标 selector 为 `0`，唯一 `!important` 和可替代白色字面量已删除；hover 阴影的低透明度
`rgba` 因现有 shadow token 不等价而暂时保留并登记。Proposal/workflow/shaping `5/5`、Dark `2/2`、
typecheck/lint/diff check 通过，覆盖 collaboration 展开、edit、accepted/blocked、Dark surface、console 和
document overflow。合计净减 123 行；当前 Web CSS 为 `140 files / 39,033 lines`，Function ID 不变。

T13-O.5 proof：52 个 rule block、69 个 selector branch、65 个 unique selector 从
`components.css 9,590 -> 9,217` 收敛到 372 行 `channel-workflow-context.css`。root import 紧随 Channel
Proposal owner，复现原 components cascade；`.context-source-detail-*`、`.context-packet`、
`.workflow-context-*` 在旧 owner 命中为 `0`，focused owner 的 forbidden/color scan 为 `0`。两个加强场景
`2/2`、recent-context/Dark 组合 `5/5`、typecheck/lint/i18n/build/diff check 全部通过，panel/work-cell/document
overflow 与 console/pageerror 为零。新增一个 focused 文件、aggregate 净减 373 行且 root import 增加 1 行，
所以当前 Web CSS 为 `141 files / 39,033 lines`；Function ID 不变。

T13-O.6 proof：271 行、37 个 rule block、46 个 selector branch、22 个 class root 从
`components.css 9,217 -> 8,945` 原样迁入 `styles/shared/conversation-terminal-report.css`；root import 紧随
`components.css`，`.terminal-report-*` 在旧 owner 命中为 `0`。新 owner 无 `!important`、Theme selector、
`transition: all` 或 private keyframe；5 个历史 fallback hex occurrence 与 1 个 tooltip `rgba` 阴影为保持当前
Light/Dark 计算值而显式保留，后续只能在等价 Theme token 建立后替换。普通对话、频道、暗色私聊 `3/3`、
typecheck/lint/i18n/build/diff check 全部通过，report/document overflow 与 console/pageerror 为零。新增一个
focused 文件、aggregate 净减 272 行且 root import 增加 1 行，因此 Web CSS 为 `142 files / 39,033 lines`；
Function ID 不变。

T13-O.7 proof：299 行目标 family 从 `layout.css 1,620 -> 1,321` 迁入 298 行
`conversation-message-frame.css`，root import 紧随 `layout.css`、位于既有 `teammates.css/components.css` 之前，
保持原 unlayered cascade；旧 owner 目标 selector 为 `0`。它是 shared baseline，不是唯一最终视觉 owner：后加载
`components.css/strict-console.css` 仍有 14 个精确 selector override；focused owner 的 9 个 `rgba()` 因现有 Theme
token 无严格等价值而登记保留。三类 Feed/Composer `11/11`、频道/私聊语义场景 `4/5 + 1/1`、typecheck、
lint、i18n、生产 build、containment/overflow 和 diff check 通过。新增一个 focused 文件、aggregate 净减 299 行且
root import 增加 1 行，因此 Web CSS 为 `143 files / 39,033 lines`；Function ID 不变，packaged Desktop 仍 pending。

T13-O.8 proof：`.artifact-preview-*` 与 `.image-compare-*` family 从 `components.css 8,945 -> 8,628`
迁入 319 行 `styles/shared/conversation-artifact-preview.css`；root import 紧随原 owner，旧聚合文件目标 selector
命中为 `0`。focused owner 无硬编码颜色、`!important`、Theme selector、`transition: all` 或私有 keyframe。
focused `2/2` 覆盖文本 loading/content/error/download/focus-return 与图片四种 compare mode、Dark/reduced motion、
range control、panel/body/image containment；既有 Channel/Runtime `2/2`、Web typecheck/lint/i18n/build、
console/pageerror/document overflow、selector scan 和 diff check 全绿。新增一个 focused 文件、aggregate 净减
317 行且 root import 增加 1 行，因此 Web CSS 为 `144 files / 39,036 lines`；Function ID 不变，packaged
Desktop 仍 pending。

T13-O.9 proof：共享 `.conversation-status-*`、`.conversation-guidance-*` baseline 与 Channel
`.channel-active-status-strip` final override 从 `components.css 8,628 -> 8,289` 分别进入 240 行
`styles/shared/conversation-runtime-feedback.css` 和 467 行 `channel-feed-composer.css`；Web 下两份零消费者
同名 component 副本删除，production owner 固定为 conversation package。新 shared owner 无颜色字面量、
`!important`、Theme selector、`transition: all`、私有 keyframe 或 literal z-index；26px action 与手写 absolute
Menu 删除，shared IconButton/Radix Menu 接管。package `12/12`、focused `2/2`、完整 Channel + Teammates
`126/126`、typecheck/lint/i18n/build/diff、console/pageerror/document overflow 全绿。新增一个 focused CSS，
aggregate 净减 339 行、Channel owner增加 46 行且 root import 增加 1 行，因此 Web CSS 为
`145 files / 38,984 lines`；Function ID 不变，packaged Desktop 仍 pending。

T13-O.10 proof：角色详情 Body/Advanced/Meta/Prompt/Workflow family 从 `teammates.css` 迁入 308 行
`teammate-management-role-detail.css`；Portal owner 以 `.teammate-role-detail-dialog` 为公开 scope，不依赖
Settings/Teammates workspace 祖先。零消费者旧 Sheet/Hero/phase-token 及 aggregate mixed branch 删除，Channel
`.workflow-step-card.compact` 进入 535 行 `channel-execution-proposal.css`，私聊 `.teammate-pack-label` 进入 212 行
`teammate-private-header.css`。`teammates.css/components.css/strict-console.css` 分别降至 `946/8,259/1,024` 行；
focused owner 的颜色字面量、`!important`、Theme selector、`transition: all`、私有 keyframe 和 package-private
selector 命中均为 `0`。focused `3/3`、Create `5/5`、Settings/Teammates/Dark `40/40`、Channel + Web release
`117/117`、typecheck/lint/i18n/build/diff、三张原尺寸证据和 console/pageerror/overflow 全绿。新增一个 focused
文件且净减 208 行，Web CSS 为 `146 files / 38,776 lines`；Function ID 不变，packaged Desktop 仍 pending。

T13-O.11 proof：417 行 Evidence/avatar-stack source family 从 `components.css` 迁出；50 个 live rule 收敛为
309 行 `shared/conversation-evidence.css`，8 个零消费者 `.teammate-avatar-stack*` rule/69 行直接删除。
`EvidenceDisclosure` 使用 shared Button，保留默认折叠、local state 与 `aria-expanded`。`components.css` 降至
7,842 行，source/dead selector 命中为 `0`；focused owner 的颜色字面量、`!important`、Theme selector、
`transition: all`、private keyframe、literal z-index 与 package-private selector 命中均为 `0`。focused `3/3`、
Runs `7/7`、Teammate Feed/Composer `4/4`、Channel web evidence `1/1`、typecheck/lint/i18n/build/diff、三张原尺寸
证据和 console/pageerror/overflow 全绿。新增一个 focused 文件且净减 107 行，Web CSS 为
`147 files / 38,669 lines`；Function ID 不变，packaged Desktop 仍 pending。

T13-O.12 proof：257 行 shared FileChange/DiffViewer source block 从 `components.css` 迁入 256 行
`shared/conversation-file-diff.css`；43 个 selector 全部 live，dead `0`，source baseline 命中归零。WorkCell 两条、
Artifact hover 一条和 Workspace Review 一条场景 override 原位保留并以 focused E2E 锁定。FileChange preview
request 改为 identity + single attempt，失败稳定显示且同一 attempt 请求数为 `1`。首轮证据发现的 ArtifactRow
layout migration omission 在现有 owner 中恢复为 120 行两行 grid，no-overlap 断言和 selected regression 通过。
focused owners 无颜色字面量、`!important`、Theme selector、`transition: all`、private keyframe、literal z-index
或 package-private selector；focused `4/4`、selected `49/49`、typecheck/lint/i18n/build/diff、四张原尺寸证据和
console/pageerror/overflow 全绿。Web CSS 为 `148 files / 38,740 lines`；Function ID 与 packaged Desktop 不变。

T13-O.13 proof：499 行 source Summary/attention family 从 `components.css` 迁出；live Summary Row、Popover shell、
Environment/Context/Progress rows 收敛为 279 行 `shared/conversation-summary.css`，约 200 行零消费者 queue
item/pill/list family 直接删除。surface placement/motion adapter 原位保留，source/dead roots 归零；focused
Summary/Evidence `9/9`、Input `4/4`、MCP `2/2`、selected `152/153 + exact repeat 2/2` 与 static/build gate 全绿。
T12.1b 另以 19 行 `channel-activity-controls.css` 在 strict layer 后关闭 34px/36px nested input 冲突；MCP 与
Channel Create raw search 同步获得局部 native focus reset。Web CSS 为 `150 files / 38,562 lines`；Function ID 与
packaged Desktop 不变。

T13-O.14 proof：Activity/Details、row/toggle/copy、CommandBatch、shell command、inline change preview、evidence
links 与 WorkCell 专属 keyframe/reduced-motion 从 `components.css` 迁入 720 行
`shared/conversation-work-cell-activity.css`。旧 final-report、shell-card 和 empty family 加结构性 dead child branch
共 `15 rules / 16 branches` 删除；Artifact Strip completed/reduced-motion 与 shared `conversation-settle-in` 留在原
owner。focused `5/5`、selected consumer `6/6`、完整 File Diff `4/4`、六张原图、keyboard、console/pageerror/
overflow 通过。Web CSS 为 `151 files / 38,457 lines`，`components.css 7,085 -> 6,259`；Function ID 与 packaged
Desktop 不变。

T13-O.15 proof：825 行 non-contiguous WorkCell shell/artifact/reference source 经审计后收敛到 690 行
`shared/conversation-work-cell-shell-artifacts.css`；25 dead rules / 30 branches 删除，shared keyframe、通用文件菜单、
O.14 与 File Diff adapter 原位保留。截图门禁发现 `.workspace-file-open-trigger` 旧 owner 断链，新增 32px
token-only Artifact Row adapter 后不再出现原生灰色按钮。focused `3/3`、O.14/File Diff 组合 `12/12`、
App/Channel/Teammates/Dark `147/147`、typecheck/lint/i18n/build/diff、五张证据和 console/pageerror/overflow 全绿。
Web CSS 为 `152 files / 38,323 lines`，`components.css 6,259 -> 5,434`；Function ID 与 packaged Desktop 不变。

T13-O.16 proof：583 行 Channel Activity/Work Thread source 与 `strict-console.css` Activity repaint branches 收敛到
556 行 `channel-activity-work-thread.css`；4 个 dead rules 和 1 个 dead mixed branch 删除，Work Thread 无结果项补齐
独占行与 top alignment。`channel-activity-controls.css` 保持 19 行和最后加载，不重开 T12.1b。focused `2/2`、
Channel Activity `7/7`、Runtime/Dark/Input `25/25`、typecheck/lint/i18n/build/diff、七张证据和
console/pageerror/overflow 全绿。Web CSS 为 `153 files / 38,296 lines`，`components.css 5,434 -> 4,867`；
Work Thread product chrome 仍关闭，Function ID 与 packaged Desktop 不变。

T13-O.17 proof：expanded AppShell Sidebar、primary navigation、sections、rows、branch form/list 与 fixed footer 从
`navigation/layout/components/sidebar` 四处收敛到 737 行 token-only `app/sidebar-layout.css`。确认无消费者的旧
brand/toolbar/inbox/hash/status/mention/direct-selected/config family 归零；`components.css 4,867 -> 4,384`、
`sidebar.css 1,816 -> 1,148`、`layout.css 1,321 -> 1,063`、`navigation.css 82 -> 4`。focused `4/4`、既有
Sidebar `8/8`、组合 `12/12`、App/Channel/Teammates/Archive/Dark `149/149`、typecheck/lint/i18n/build/diff、
十张证据和 console/pageerror/overflow 全绿。Web CSS 为 `154 files / 37,547 lines`；compact rail consolidation
留给 O.18，Function ID 与 packaged Desktop 不变。

T13-O.18 proof：48px compact rail、three section preview/stack、compact identity/action visibility 与 local
hover/focus 从 `sidebar.css` 收敛到 396 行 token-only `app/sidebar-rail-sections.css`；`<=900px` 内 broad
`.channel-drawer-shell` 的完整 compact 复制删除，AppShell authoritative collapsed class 在 900px 内控制初始
状态，Show navigation 后直接回落 O.17 expanded owner。`sidebar.css 1,148 -> 192`；focused + existing Sidebar
`16/16`、App/Channel/Teammates/Archive/Dark `149/149`、typecheck/lint/i18n/build/diff、九张证据和
console/pageerror/overflow 全绿。Web CSS 为 `155 files / 36,988 lines`；Function ID 与 packaged Desktop 不变。

2026-07-29 correction：上述 proof 是旧 identity rail 的历史完成证据，产品合同已被 compact launcher rail
取代。当前 owner 为 175 行；对象 list/preview/stack 不在 collapsed DOM 中，三个 launcher 的数量与 rail
高度不受业务数据影响。旧截图保留但不再作为当前视觉基线。

T13-O.19 proof：`strict-console.css` 的 Model-specific Provider repaint 与 `components.css` 的旧 Provider
source family 已释放；18 个 dead roots、旧七列表格、旧 panel header/menu 和 pre-primitive branches 归零。
跨域 `.provider-run-notice` 五个生产消费者、通用 `.status-badge.provider` 和 focused-surface exclusion 保留。
`strict-console.css 1,008 -> 682`、`components.css 4,384 -> 4,323`；Model focused cluster `612 -> 632`，
增量 20 行低于 40 行上限。focused/legacy/productization `25/25`、Settings/Dark `26/26`、broad `149/149`、
八张重采证据、typecheck/lint/i18n/build/diff、dead/source/forbidden/console/pageerror/overflow 全绿。
Web CSS 为 `155 files / 36,619 lines`，净减 369 行；Function ID 与 packaged Desktop 不变。

T13-O.20 proof：`strict-console.css` 的 Automations-specific repaint 与 11 个 dead roots 已删除；三个 live
semantic DOM roots 保留，但聚合 CSS 仅通过 `:where(:not(.workspace-automations-surface))` negative exclusion
释放该 surface，避免 plain `:not()` 提高其他 workspace selector 的 specificity。`automations/page.css`
`111 -> 113` 只补 authoritative root geometry，controls、DataRow、Dialog、Inspector 仍由 shared/focused owner
持有。`strict-console.css 682 -> 584`，Web CSS 净减 96 行至 `155 files / 36,523 lines`。focused `6/6`、
legacy `2/2`、existing combined `68/68`、broad `149/149`、八张 Light/Dark/imported Theme 证据与
typecheck/lint/i18n/build/diff、dead/source/forbidden/console/pageerror/overflow gate 全绿；Function ID 与
packaged Desktop 状态不变。

T13-O.21 proof：`teammates.css 946 -> deleted`，legacy file/import 与 positive writer 引用归零；
`strict-console.css 584 -> 462`、`components.css 4,323 -> 4,313`。新/扩展 owner 为
`teammate-management-shell.css=59`、`shared/teammate-avatar.css=19`、
`teammate-private-feed-composer.css 208 -> 235`、`conversation-message-frame.css 298 -> 299`；Avatar base
writer 唯一。新声明 forbidden literal 命中为 `0`，Message Frame 既有十项 accepted exception 不归 O.21。
Web CSS 为 `156 files / 35,552 lines`。新专项 `8/8`、focused selected `19/19`、全部 management `74/74`、
跨模块 `171/171`，Input focus containment、Avatar cross-domain、Quiet Ocean、console/pageerror/overflow/
reduced-motion、lint/i18n/typecheck/build/diff 全绿；Function ID 与 packaged Desktop 状态不变，O.22 仅做
下一轮只读 aggregate candidate audit。

T13-O.22 proof：`layout.css 1,063 -> 919`、`components.css 4,313 -> 4,269`、
`strict-console.css 462 -> 457`，十个生产/E2E 零引用的 Channel Tabs / Utility Tabs / Task Strip / Client Task /
Composer head / Dock head family 已从全部 CSS owner 删除。唯一 live `task-strip-head` 保持 10 个生产消费者，
迁入 `channel-activity-work-thread.css 556 -> 575` 并成为唯一 owner。Web CSS 为 `156 files / 35,378 lines`，
净减 174 行。新专项 `3/3`、selected Runtime/Workspace/Dark/Theme/Input `43/43`、lint/i18n/typecheck/build/diff
与三张 Light/Dark/Quiet Ocean 证据通过；Channel full `104/105` 的唯一 Tokenized Composer fill 偶发残留
独立 repeat `2/3`，作为非 O.22 行为稳定性候选保留。Function ID 与 packaged Desktop 状态不变。

T13-O.23 proof：`components.css 4,269 -> 4,195`，八个无生产消费者的旧手写 Run Guidance
input/list/row family 在生产/CSS 中归零，新专项仅保留负向 absence guard；唯一 live `.run-guidance-panel`
保持 `1` 个生产、`2` 个既有 E2E 消费者，迁入
4 行 `runs/guidance.css`，`runs.css 8 -> 9` 只增加 focused import。Web CSS 为 `157 files / 35,309 lines`，
净减 69 行。新专项 ordinary/capture 各 `3/3`、Runs/Runtime `26/26`、selected `41/42`、broad `157/158`；
Menu outside-click 独立 `1/3`、Teammate membership 独立 `3/3`，均与 O.23 selector 无交集并独立登记。
lint/i18n/typecheck/build/diff 与三张 Light/Dark/Quiet Ocean 证据完成；Function ID 与 packaged Desktop 不变。

T13-O.24 proof：`.workspace.workspace-generation-surface` 的唯一 positive owner 位于
`features/media-production/shell.css`，`strict-console.css` 专属 positive writer 为 `0`。
`workspace/layout/components/strict-console/app-shell-overlay-size` 共 31 个 selector branch 排除 Media，其中 24 个 Dark
descendant blanket 和单独 Dark root 不再覆盖 shared primitives。首次 focused `0/3` 暴露冻结审计漏记的
AppShell 后加载滚动规则；补齐后 ordinary/capture 各 `3/3`、selected `31/31`、broad final `64/64`。
`strict-console.css 457 -> 439`、`media-production/shell.css 95 -> 104`，Web CSS 为
`157 files / 35,300 lines`，净减 9 行。三张 Light/Dark/Quiet Ocean 证据、lint/i18n/typecheck/build/diff 全绿；
Function ID 与 packaged Desktop 不变。

T13-O.25 proof：`components.css 4,195 -> 3,743`，Channel workspace grid、Dock frame/panel motion、resize handle、
desktop width 与协议/Inspector adapter 迁入 161 行 `channel-right-dock/shell.css`；facade `3 -> 4` 行并在首位
加载 shell。最终 static gate 又删除 `layout.css` 中 12 行零消费者 `.channel-files`（`919 -> 907`）。四文件
写集合净减 302 行，当前 Web CSS 为 `158 files / 34,998 lines`。package
`RightDockShell` 继续独占两行布局、border、semantic background、Header、Body、Launcher、Rows 与 controls；
focused owner 未复制 package chrome。旧 side-panel chrome、Review、management adapter 和 `channel-files` 的生产
消费者与 CSS writer 均为 0。focused ordinary/capture 各 `3/3`、selected `26/26`、Channel/Workspace/Dark/Theme
broad `125/125`、Form `4/4`、三张 Light/Dark/Quiet Ocean 证据和 static/build gate 全绿；Function ID 与
packaged Desktop 不变。

T13-O.26 proof：`runs/intervention-row.css=126` 新增专用 productization owner，`runs.css` 增加 1 行 import，
`run-detail.css` 移出旧 grouped intervention writer。Run Guidance/Thread Evidence 分别使用 actionable/read-only
presentation；`components.css=3,743`、`strict-console.css=439`、`layout.css=907` 未扩大。Web CSS 从 O.25
`158 files / 34,998 lines` 到 `159 files / 35,124 lines`，明确净增 126 行产品结构，不计为 aggregate cleanup。
focused ordinary/capture 各 `3/3`、selected `36/36`、broad `48/48`、static/build 和三张原尺寸证据通过。

T13-O.27 proof：package 新增 235 行 `message-frame.css` 与 146 行 `message-action-bar.css`；Web 将 299 行
`conversation-message-frame.css` 收缩为 27 行边界 owner，并新增 438 行 `channel-message-transcript.css`。
`components.css 3,743 -> 2,890`、`strict-console.css 439 -> 434`、`layout.css=907`；Web CSS 从 O.26
`159 files / 35,124 lines` 到 `160 files / 34,438 lines`，净减 686 行。Normal 不再输出 Channel class，三个 dead
family 和 aggregate generic writer 为 0。package `17/17`、focused ordinary/capture 各 `3/3`、三张原图与
static/build 通过；旧 Tooltip/hover 与 Guidance Menu 测试合同残余见 evidence metadata。

T13-O.29/O.30 proof：O.29 仅在 `layout.css`、`components.css`、`strict-console.css` 删除 28 个精确
hard-dead prototype family，分别净减 `376 / 34 / 13` 行，同时保留 pending assets、mention 和 channel action
live branch。O.30 删除 11 个 Web 会话重复实现；Web MessageBubble/CopyActionButton 只保留 renderer/i18n adapter，
package 继续持有消息结构、copied state 和 Radix Tooltip。Web CSS 从 `160 files / 34,438 lines` 降至
`160 files / 34,015 lines`，`components.css=2,856`、`strict-console.css=421`、`layout.css=531`。package
`18/18`、focused ordinary/capture 各 `8/8`、broad `165/165`、六张原图与 static/build 通过；未增加全局
`input:focus`；该时点剩余 raw input 后由 T12.1c 页面迁移关闭。

T13-O.31 proof：package Composer 删除 `composer-panel/composer-drop-zone/composer-primary-actions/composer-tool-row`
四个 compatibility class，`conversation-composer-slots.css=301` 成为 pending assets、preview、picker、drop hint、
attachment trigger 与 file-reference 的唯一 Web owner。Channel/Normal/Teammate focused owner 只通过 canonical
data/class 持有 surface adapter；aggregate/strict duplicate writer 和两个零消费者组件归零。Web CSS 从
`160 files / 34,015 lines` 降至 `161 files / 33,864 lines`；`components.css 2,856 -> 2,202`、
`layout.css 531 -> 494`、`strict-console.css 421 -> 386`，focused files 为 `764 / 356 / 234` 行。package
`20/20`、focused ordinary/capture 各 `4/4`、existing `18/18`、broad 初始 `162/165` + stale locator exact
`3/3`、三张原图通过；focus ring 使用 inset，不新增全局 `input:focus`。

T13-O.32 proof：Plugin root 从 `strict-console.css` 的 1 个 generic Dark root repaint 与 21 个 descendant
blanket 全部释放；`strict-console.css 386 -> 385`。删除 1 行 `plugin-cua-health.css` facade 和 `styles.css`
唯一 import，真实 CUA owner 仍为 `plugins/plugin-cua-install.css`；`.settings-plugin-token` 归零。Plugin focused
feedback 的两个 selector 改用 shared InlineFeedback public detail slot，不再选择 package 私有 class，7 个 focused
文件仍为 549 行。Web CSS 从 `161 files / 33,864 lines` 降至 `160 files / 33,861 lines`。package `51/51`、
focused ordinary/capture 各 `4/4`、Plugin `17/17`、selected `26/26`、representative release `12/12` 与三张
原图通过；未新增 Theme override 或全局 patch。

T13-O.33 proof：`components.css 2,202 -> 2,118`，删除四个零消费者 Route Explanation root family；
`channel-message-transcript.css 438 -> 435`，只清除同一 dead family 的残余 branch。O.33 可归因净减 87 行，
live `channel-route-inspect-grid/section`、FileRefChip、message footer 与 Activity Feed owner 保留。当前共享工作树
机械统计为 `159 CSS files / 33,673 lines`；该快照包含其他进行中的共享树变化，不全部归因于 O.33。
focused ordinary/capture 各 `3/3`、selected `18/18`、typecheck/lint/i18n/build/diff 与两张原图通过。

P10.2 proof：五个旧 Media Production CSS owner 已删除（S0 脏树快照 `2,432` 行；相对 HEAD 的 tracked
baseline 为 `2,438` 行），`styles.css` 只加载
`features/media-production/index.css`。closeout 后 Dock owner refinement 的 focused owner 为
`canvas 355 / dialogs 165 / dock 103 / index 7 / inspector 288 / project-scene 268 / shell 95 / workflow 316`，
合计 `1,597` 行。focused CSS 中颜色字面量、
`!important`、`transition: all`、Theme selector 和 package-private `.ling-ui-*` 命中均为 `0`；共享组件继续拥有
Input/Select/Button/Dialog/Inspector/Feedback chrome。focused `27/27`、legacy `8/8`、Media Jobs `16/16`、
Dark `2/2` 和 36 个浏览器证据场景通过；packaged Desktop CSS/renderer 验收仍由 Desktop lane 所有。

T13-H proof：无生产调用的 `ActionMenuItem`、compatibility export 和 87 行 `action-menus.css` 已删除；
`providers.css` 空 marker 与 `model-workbench.css` 单行 facade 也已删除。`styles.css` 在原 facade 的 cascade
位置直接加载 `features/model-workbench/index.css`，没有前移 Model visual owner；无 selector 的 `forms.css`
占位文件及 import 同步删除。引用扫描为 `0`，Web CSS 从 143 文件 / 40,543 行降为 139 文件 / 40,447 行；
typecheck、lint 和独立端口 App/Model/Dark `46/46` 通过。

## T13-P.3 Current Closeout

本节是当前工作树机械快照，不覆盖上方 P.2、O.25-O.33、P3 foundation 或 P3-B 的阶段证据：

- Web CSS 当前为 `163 files / 33,427 lines`；重点聚合文件为 `components.css=1,881`、
  `workspace.css=713`、`layout.css=490`、`strict-console.css=335`、`sidebar.css=138`；
- P.3 focused owners 为 `channel-proposed-plan.css=80`、`channel-workflow-status.css=13`、
  `channel-runtime-diagnostics.css=128`；`teammate-management-mcp.css` 当前为 `313`；
- `SelectControl=0/0`、`CreateDialogShell=0/0`、`OperationEmptyState=0/0`，三个 facade 的 component、export
  和生产调用均归零；`select-controls.css` 保持 deleted；`StatusBadge=1/1`，只保留 AppShell 产品决策前调用，
  不在本 closeout 删除 adapter 或 CSS；
- P.3 A-X 范围内已分配的 implementation、read-only 和 evidence 项 `A-H`、`J-L`、`N-X` 已完成；
  `M` 未分配，主控整合由 P3-I 关闭；P3-Y 仍是 AppShell generic run status 的独立产品决策，不在 CSS
  closeout 中代替用户选择；
- focused owner 与正式证据入口分别为
  [Channel Proposed Plan](../evidence/conversations/channel-proposed-plan/metadata.md)、
  [AppShell Geometry](../evidence/shell/app-shell-geometry-p3/metadata.md)、
  [Channel Workflow Status](../evidence/conversations/channel-workflow-status/metadata.md) 和
  [Runtime Diagnostics Status](../evidence/features/runtime-diagnostics-status/metadata.md)。

## T13-P.4 Current Closeout

- Web CSS 当前为 `163 files / 33,210 lines`；`components.css=1,802`、`workspace.css=608`、
  `layout.css=457`、`strict-console.css=335`、`sidebar.css=138`。
- 16 个 exact generic class 的 production emitter/CSS writer 双零；focused/static gate 同时保护
  FirstRun、Runtime KPI/Audit、meta/tool/provider/status 和 focused capability owner。
- 三个聚合文件相对 P3 snapshot 净减 217 行；CSS 文件数、import 顺序、Theme/Desktop layer 均不变。
- static `4/4`、selected `28/28`、Runtime capture `4/4` 和 static/build gate 全绿；正式 Runtime evidence
  hash 未变化。P3-Y `StatusBadge=1/1` 继续保留，不由本 CSS closeout 推断完成。

## T12.1d Aggregate Native-Control Owner Release

- `components.css 1,777 -> 1,717`、`workspace.css 608 -> 573`、`layout.css 457 -> 455`；MCP narrow-column
  containment follow-up 将 focused owner `313 -> 332`，当前 Web CSS 为 `163 files / 32,977 lines`。
- 三个 aggregate 文件不再定义 `input/textarea:not([data-ling-control-native])` 的 default、placeholder、focus、
  disabled、radius 或 Dark branches；shared package 和 focused feature CSS 成为唯一视觉 owner。
- Web `18` 个 checkbox/file/range 与 package task-list checkbox 保留原生语义并声明
  `data-ling-control-native="true"`。唯一 decision-gated Work Thread Search 继续由 19 行 focused owner 持有。
- 本项不改变 CSS import 顺序、Theme/Desktop override、API、状态机或 Function ID。
