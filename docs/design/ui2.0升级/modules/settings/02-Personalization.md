# Personalization

Implementation plan: [P7A.3 Personalization](02-Personalization-implementation-plan.md).

## Current Product Decision

2026-07-29 收口：移除整个“高级治理”区域、回话语气来源标签、所有默认层辅助小字和两个手动刷新按钮。
个性化只保留可编辑的表达风格、候选生成、录制模式和保存动作。候选发布和绑定的人工审核约束仍然生效，但不再作为默认层灰色说明。治理来源和存储路径
只进入“启动与诊断”的技术详情，不再出现在个性化页面。

## Goal

Personalization 只管理 Ling 的表达方式、技能生成和治理策略。响应语言继续属于 Interface Preferences。
默认层不展示内部 prompt、raw policy、source/path 或重复说明。

## Function Points

- `SETTINGS-PERSONAL-TONE-001`：表达风格和偏好。
- `SETTINGS-PERSONAL-SKILL-001`：技能生成策略。
- `SETTINGS-PERSONAL-GOVERN-001`：已退出个性化默认层；只读高级治理区不再作为产品功能点。
- `SETTINGS-PERSONAL-SAVE-001`：保存、成功和失败。

旧草案的 `SETTINGS-PERSONAL-LANGUAGE-001` 在实现前废止；实际能力由
`SETTINGS-INTERFACE-RESPONSE-001` 继续拥有。

## Layout

Tone 使用 SegmentedControl，Skill policy 使用两个 Field/Select。页面进入时自动加载，不提供手动刷新；
字段下不重复解释当前选项，也不展示非操作性安全小字。source/path 进入启动诊断技术详情，不保留高级折叠区。
保存反馈使用 Toast，字段或策略阻塞使用 InlineFeedback。

## States

loading、dirty、saving、saved、validation error、policy unavailable。

## Tests

`settings.spec.ts`、Skill specs、`ling-light` / `ling-dark`。中英文语义对齐，不出现内部英文 key。
