# P7A.3 Personalization Implementation Plan

Status: `verified` on 2026-07-20. Slice owner: P7A.3.

2026-07-28 product simplification supersedes the Advanced governance presentation below:
remove the InspectorSection, fixed guards and source/path from Personalization; retain the two editable Selects,
Save action and one manual-review safety note. Historical closeout evidence remains historical rather than current UI truth.

2026-07-29 product simplification removes both explicit Refresh actions and all default-layer helper copy, including the
manual-review safety note. Opening the section still loads authoritative config automatically; save verification still
reloads it. Manual review remains enforced by behavior rather than repeated as muted copy.

## Scope

只迁移当前 Personalization section 的真实入口：

- `SETTINGS-PERSONAL-TONE-001`：Conversation tone 加载、选择、保存和回滚。
- `SETTINGS-PERSONAL-SKILL-001`：技能候选生成与记录策略字段。
- `SETTINGS-PERSONAL-GOVERN-001`：退役；高级治理说明、固定 guard 和 source/path 不再属于个性化页面。
- `SETTINGS-PERSONAL-SAVE-001`：Tone 与 governance 的 scoped busy、Toast 和 InlineFeedback。

响应语言继续由 `SETTINGS-INTERFACE-RESPONSE-001` 和 Interface Preferences 拥有；旧草案中的
`SETTINGS-PERSONAL-LANGUAGE-001` 在实现前废止，不移动字段、不新建重复入口。

不修改 effective config API、workspace settings shape、tone values、SkillGovernancePolicy、默认值、
兼容判定、source/path 或保存语义。

## Current Audit

- `PersonalizationSettingsPanel.tsx` 约 164 行，自己持有 API state、手写 Refresh button、两枚 radio card、
  页面 success timer 和 `.settings-inline-tip`。
- `SkillGovernanceSettingsSection.tsx` 约 99 行，独立加载/保存配置，使用手写 Refresh、常驻 success 和
  `.inline-error`。
- `SkillGovernanceSettingsPanel.tsx` 约 194 行，现有未提交工作已把两个字段迁到 shared Field/Select；必须保留。
- 两个 `<details>`、三块 fixed guard、source/path 和整段记录说明在默认层过重。
- `settings.css` 同时拥有 tone、governance 和其他 Skill Library selector，迁移必须逐引用删除，不能整段覆盖。

## Target Structure

```text
Personalization
  Conversation tone
    header
    SegmentedControl [Friendly | Pragmatic]
    InlineFeedback when load/save fails

  Skill governance
    header
    Candidate generation Field/Select
    Recording Field/Select
    Save governance policy
    InlineFeedback when unsupported/load/save fails
```

- SettingsShell 已提供页面归属，不再使用 `.panel` 卡片墙或重复说明段落。
- Tone 与 governance 是两个无嵌套卡片 section，由边界和间距分层。
- Tone 和策略字段都不显示重复的当前选项说明。
- 页面进入时自动加载，不提供手动刷新；保存成功使用全局 Toast，失败和 unsupported 持续 inline。

## Module Boundaries

- `PersonalizationSettingsPanel.tsx`：Tone state adapter 与 section composition；不吸收 Skill policy state。
- `PersonalizationToneSection.tsx`：可选 focused 纯展示组件；仅在能清晰隔离 UI 时抽取。
- `SkillGovernanceSettingsSection.tsx`：Skill policy state adapter、API、rollback、Toast/InlineFeedback owner。
- `SkillGovernanceSettingsPanel.tsx`：纯 policy presentation；shared Field/Select/Button。
- `settings-personalization.css`：Tone、governance form layout 和 1280/980 约束。
- `ui2-settings-authorization-personalization.spec.ts`：reachable states、截图、console 和 overflow owner。

所有 production 文件保持低于 800 行。若不抽 hook即可保持职责清晰，不为追求文件数量拆空抽象。

## Implementation Order

1. 在覆盖矩阵拆分 Personalization coarse ID，并把 response language ownership 指向 Interface Preferences。
2. 新增 focused spec，锁定 loading、tone rollback、Toast、governance dirty/save/unsupported/advanced。
3. Tone 迁到 shared SegmentedControl、IconButton、Skeleton 和 InlineFeedback；删除 Feature timer。
4. Governance section 迁到 shared IconButton、Skeleton、InlineFeedback 和全局 Toast。
5. Governance panel 保留现有 Field/Select 与 Button，删除 details/fixed/source/path 展示并增加一条人工审核说明。
6. 新建 focused CSS；从 `settings.css` 删除仅由 Tone/Governance 拥有的 selector，保留其他 Skill owner。
7. 跑 package/static/focused/Settings/Skill/Dark 回归和真实 Vite 双主题双 viewport验收。
8. 回写 evidence、覆盖、E2E、CSS、selector、motion、feedback 和状态看板。

## State Matrix

| State | Trigger | Required result |
|---|---|---|
| initial loading | section opens before effective config resolves | stable Skeleton; no fake Built-in source or default policy claim |
| tone loaded | config succeeds | one selected tone without repeated helper copy |
| tone saving | select another tone | tone control locally busy; governance remains usable |
| tone success | save and verification succeed | deduped global success Toast; source remains available only in technical diagnostics |
| tone failure | update or verification fails | previous tone restored; persistent InlineFeedback remains |
| governance dirty | change either Select | Save enabled; current draft retained |
| governance saving | Save action | only governance controls busy; no duplicate request |
| governance saved | save and reload succeed | global Toast; authoritative values replace draft |
| unsupported | daemon omits policy capability | fields/Save disabled and persistent repair feedback shown |
| Dark/reduced | fixed dark / reduced motion | semantic tokens and package transition contract only |

## Feedback Contract

- Tone scope: `settings:personalization:tone:save`。
- Governance scope: `settings:personalization:governance:save`。
- Success defaults to 3000ms via shared Toast; no Feature timer。
- Load/save/unsupported errors remain InlineFeedback until retry or successful resolution。
- Tone and governance feedback do not clear each other。

## Tests

- focused: `ui2-settings-authorization-personalization.spec.ts`。
- regression: `settings.spec.ts`、`ui2-settings-shell.spec.ts`、`ui2-form-controls.spec.ts`、
  `ui2-feedback-data-display.spec.ts`、`ui2-navigation-overlays.spec.ts`、`dark-mode.spec.ts` and Skill specs。
- screenshots: Personalization loaded/compact in 1440x960 `ling-light`; failure/unsupported in
  1280x800 `ling-dark`; optional 980x680 long-data stress evidence。

## Exit Gate

- Tone and governance visible controls use shared primitives; no hand-written action/radio/details equivalent remains。
- Personalization contains no Feature success timer、`.settings-inline-tip` or `.settings-inline-success` owner。
- Response language remains only in Interface Preferences。
- Advanced governance is absent; source/path only appear in Startup/Diagnostics technical details。
- Existing Field/Select migration is preserved and no API/policy semantics change。
- Focused CSS has zero color literals、`!important`、theme/profile selector、`transition: all`、private keyframe or
  package-private selector; `settings.css` only decreases。
- Focused E2E、selected regression、real Vite evidence and metadata all pass before status becomes `verified`。

## Closeout Evidence

- Tone uses shared `SegmentedControl`/`Skeleton`/`InlineFeedback`; Skill governance uses shared
  `Field`/`Select`/`Button`. The 2026-07-28 follow-up removed Advanced governance and added one safety note;
  the 2026-07-29 follow-up then removed that note, the remaining helper copy, and explicit Refresh actions.
- Tone and governance success feedback uses independent shared Toast scopes; rollback, save failure and unsupported capability remain
  persistent and repairable inline states.
- Focused `settings-personalization.css` is 258 lines. The migrated selector families were removed from `settings.css`; unrelated
  Skill Library tip owners remain for their own slice.
- Shared package `40/40`, focused P7A.3 `5/5` and final selected browser regression `33/33` passed.
- Six historical Light/Dark, loading/error/unsupported/advanced screenshots, hashes, console and overflow results are recorded in
  [P7A.3 evidence](../../evidence/settings/settings-authorization-personalization/metadata.md).
- The 2026-07-20 evidence remains historical; `SETTINGS-PERSONAL-GOVERN-001` was retired on 2026-07-28.
  Response language remains owned by P7A.4 Interface Preferences.

## Hard Stops

- Do not merge Tone and Skill API state into one fake transaction。
- Do not move response language or add a new Settings tab。
- Do not change SkillGovernancePolicy defaults or unsupported-daemon behavior。
- Do not show success both inline and in Toast。
