# Personalization

Implementation plan: [P7A.3 Personalization](02-Personalization-implementation-plan.md).

## Goal

Personalization 只管理 Ling 的表达方式、技能生成和治理策略。响应语言继续属于 Interface Preferences。
默认层不展示内部 prompt、raw policy、source/path 或重复说明。

## Function Points

- `SETTINGS-PERSONAL-TONE-001`：表达风格和偏好。
- `SETTINGS-PERSONAL-SKILL-001`：技能生成策略。
- `SETTINGS-PERSONAL-GOVERN-001`：技能治理和 evolution。
- `SETTINGS-PERSONAL-SAVE-001`：保存、成功和失败。

旧草案的 `SETTINGS-PERSONAL-LANGUAGE-001` 在实现前废止；实际能力由
`SETTINGS-INTERFACE-RESPONSE-001` 继续拥有。

## Layout

Tone 使用 SegmentedControl，Skill policy 使用 Field/Select，高级治理使用 InspectorSection。每个字段只保留
一条必要说明，source/path 和完整指南进入折叠层。
保存反馈使用 Toast，字段或策略阻塞使用 InlineFeedback。

## States

loading、dirty、saving、saved、validation error、policy unavailable、advanced open。

## Tests

`settings.spec.ts`、Skill specs、`ling-light` / `ling-dark`。中英文语义对齐，不出现内部英文 key。
