# Profile

## Goal

个人资料页面只处理身份编辑和使用洞察，不显示静态“显示预览”或重复“个人资料/身份信息”
标题。用户名不可编辑，不伪装成输入框。

## Function Points

- `PROFILE-IDENTITY-001`：头像、名称和不可编辑用户名。
- `PROFILE-AVATAR-001`：照片 icon、上传、裁剪和保存。
- `PROFILE-NAME-001`：低存在感 edit icon、内联输入和 blur 保存。
- `PROFILE-TOAST-001`：保存成功/失败反馈。
- `PROFILE-INSIGHT-001`：使用指标、热力图、技能和模型记录。
- `PROFILE-EMPTY-001`：无使用数据。

## Layout

身份块水平居中，不使用多余卡片标题。头像与名称形成一个紧凑视觉组；相机 icon 直接触发
更换头像。名称 edit icon 默认低透明度，hover/focus 清晰。使用洞察直接显示，不折叠。

## States

view、name editing、saving、save success/error、avatar uploading、crop open、crop saving、
insight loading/empty/overflow。Toast top-center，成功 3 秒自动消失。

## Components And Tests

IconButton、Input、Dialog、Toast、DataRow、EmptyState、Skeleton。`profile.spec.ts`、
`dark-mode.spec.ts`；覆盖 blur 保存、toast 消失、头像 crop 和最常用技能溢出。

## P7A.2 Settings Profile

Status：`verified`（2026-07-20）。

实施合同见 [P7A.2 Settings Profile Implementation Plan](17-Profile-implementation-plan.md)。本切片只关闭
Settings Profile；standalone Profile dashboard 不是视觉验收面，但保存与消息身份传播必须回归。

硬规则：

- 初次加载必须显示稳定 Skeleton，不得先闪出默认 `Ling User` 和假空态；
- 用户名保持只读，名称使用 inline Input，头像相机入口使用 shared IconButton；
- crop 使用 shared Dialog，Esc/outside/focus restore/busy dismiss 不得由 Feature 手写；
- activity range 使用 SegmentedControl，技能使用 DataRow，空态使用 EmptyState；
- loaded/empty/error/long/Light/Dark/980 resize 都属于可达验收状态；
- Profile 成功反馈继续使用唯一全局 Toast，失败留在 Profile InlineFeedback；
- Settings Profile CSS 不再依赖 standalone Profile 的 avatar/segmented/skill/crop selector。

### P7A.2 Closeout

- Settings identity/insight 使用 shared IconButton/Input/SegmentedControl/DataRow/EmptyState/Skeleton；
- crop 使用 shared Radix Dialog，删除 Feature global Esc/backdrop，native chooser 关闭后显式恢复头像焦点；
- initial loading、loaded、empty、load error、name cancel/save/failure、invalid file、crop 和 long data 均有自动化；
- 英文分钟、月份和技能单复数不再泄漏中文或错误复数；
- focused `4/4`、Profile `7/7`、selected `54/54` 和四张实页证据通过；
- 证据：[P7A.2 Settings Profile Evidence](../evidence/settings/settings-profile/metadata.md)。

## P11.4 Profile Regression

Status：`verified`（2026-07-23）。本切片不重建设计，只验证后续 shared component/CSS 变更没有让
Profile 六个 Function ID 回退，并补齐当前双尺寸、跨主题和 changed-state 证据。

- 1440 Light 覆盖 inline name blur autosave、可观察 saving、唯一全局 success Toast 和约 3 秒消失；
- 1280 Dark + reduced motion 覆盖 avatar chooser、crop 初始焦点、Cancel/focus restore、确认保存失败、
  avatar rollback、无 success Toast、错误超过 3 秒仍持续；
- focused 继续覆盖用户名只读、usage 默认展开、loading/empty/data/long skill、keyboard、input focus containment、
  console 和 document root overflow；
- focused `6/6`、legacy Profile `3/3`、Settings `17/17`、Dark `2/2`，最终串行合计 `28/28`；
- 未发现真实 Profile 生产缺陷，因此本切片没有修改 Profile Feature/CSS/API/路由/存储；
- 六张当前 Profile PNG 均已核对尺寸、SHA-256 并按原图复核；只新增 Toast 与 avatar-error 两张缺口图，
  其余四张证据未重拍。完整清单见 [P7A.2 / P11.4 Profile Evidence](../evidence/settings/settings-profile/metadata.md)。

U13 closeout：`strict-console.css` 的 `data-theme + .profile-page` 全局兼容 selector 已删除；Settings Profile
为 identity、usage、name row 和 summary 增加公开 data contract，四个历史 E2E owner 已迁离关键视觉 class。
`profile.css` 中被 standalone Profile 使用的 selector 仍是有效 owner并完整保留；本次未重开已验证行为或
删除独立资料页。Profile/App/Dark/Feedback selected regression `32/32` 通过。
