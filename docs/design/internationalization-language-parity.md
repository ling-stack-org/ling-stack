# Ling Internationalization And Language Parity

Status: canonical product and architecture contract
Owner: Web, Desktop, Daemon, and release maintainers
Last verified: 2026-09-03
Document type: product and architecture contract
History: This contract supersedes the earlier i18n alignment contract and its completed implementation plan; both are preserved in Git history.
Code anchors: `packages/localization`, `apps/web/src/i18n`, `packages/contracts/src/settings.ts`, `apps/desktop`
Test anchors: `packages/localization/test`, `apps/web/test`, `apps/web/e2e/i18n-language-parity.spec.ts`, `apps/desktop/tests/packaged-language-parity.mjs`, `apps/desktop/tests/run-packaged-language-parity.mjs`

## Summary

Ling 的界面语言、AI 回复语言和 Desktop 原生界面使用与当前 Codex Desktop 主 Webview
同范围的 55 个 locale。本合同同时定义可持续的翻译目录、差异同步、质量门禁和打包验收流程。

本能力不是“多放几份字典”。它必须同时解决：

- 产品界面语言与 AI 回复语言的语义分离；
- Web 与 Desktop 共用同一 locale 注册表；
- Daemon、频道、会话和私聊对显式回复语言的统一处理；
- 语言包按需加载，避免 55 份字典进入首屏 JavaScript；
- 新增或修改文案后可以只翻译变化内容；
- 每个已声明支持的 locale 都有完整目录，不能依赖悄悄回退到英文冒充完成；
- macOS 打包产物中的语言切换必须经过真实运行验证。

## Reference Boundary

2026-08-27 对本机 `/Applications/ChatGPT.app` 版本 `26.820.60940` 进行只读资源核对：

- 主 Webview 产品层暴露 55 个 locale 映射；
- Electron/macOS 原生菜单层包含 65 个 locale 资源；
- 两者不是同一产品合同。

Ling 对齐 55 个主产品 locale。原生菜单中额外存在但未出现在主产品映射里的语言，不得仅因
Electron 携带资源就标为 Ling 已支持。

该参考只用于确定首版语言集合，不建立运行时依赖。Codex 后续增加或删除语言时，Ling 通过
独立评审更新自己的注册表，不在构建时读取外部应用包。

## Supported Locale Contract

首版产品语言集合固定为：

| Group | Locales |
| --- | --- |
| Baseline | `en-US`, `zh-CN`, `zh-HK`, `zh-TW` |
| Europe | `bg-BG`, `bs-BA`, `ca-ES`, `cs-CZ`, `da-DK`, `de-DE`, `el-GR`, `es-ES`, `et-EE`, `fi-FI`, `fr-FR`, `hr-HR`, `hu-HU`, `hy-AM`, `is-IS`, `it-IT`, `ka-GE`, `lv-LV`, `mk-MK`, `nb-NO`, `nl-NL`, `pl-PL`, `pt-PT`, `ro-RO`, `ru-RU`, `sk-SK`, `sl-SI`, `sq-AL`, `sr-RS`, `sv-SE`, `tr-TR`, `uk-UA` |
| Americas | `es-419`, `fr-CA`, `pt-BR` |
| Asia | `bn-BD`, `gu-IN`, `hi-IN`, `id-ID`, `ja-JP`, `kn-IN`, `ko-KR`, `mr-IN`, `ms-MY`, `my-MM`, `ta-IN`, `te-IN`, `th-TH`, `vi-VN` |
| Africa | `so-SO`, `sw-TZ` |

`en-US` 是源语言和故障回退语言。`zh-CN` 继续作为现有 Ling 安装在无可匹配系统语言时的
产品默认值，以避免无设置用户被无意切换语言。

所有 locale 使用规范 BCP 47 标签。别名只用于输入归一化，例如：

- `zh`, `zh-Hans`, `zh-SG` -> `zh-CN`
- `zh-Hant`, `zh-MO` -> `zh-TW`
- `en`, `en-GB`, `en-AU` -> `en-US`
- `es` -> `es-ES`
- `pt` -> `pt-BR`
- `no` -> `nb-NO`

别名不作为持久化值，不生成重复语言包。

## Product Semantics

### Interface language

界面语言控制 Ling 自己的可见产品文案：导航、设置、审批、状态、空态、错误、按钮、
Desktop 原生对话框、Computer Use 预览和无障碍名称。

它不翻译：

- 用户输入和 Agent 历史回复；
- 代码、命令、日志、路径、文件名和 API 字段；
- 第三方工具原始输出；
- 用户创建的频道名、会话名、Agent 名和任务标题。

### AI response language

AI 回复语言是独立偏好，值为 `follow_user` 或任一 `SupportedLocale`。切换界面语言不得自动
修改它，切换回复语言也不得改变界面。

`follow_user` 不使用当前“中文字符即中文，否则英文”的二分类器强制选择语言。Runner 收到
明确的“跟随最近用户消息语言”约束，由模型保持用户语言；Daemon 生成的产品错误和状态通过
结构化 code 交给界面本地化，不依赖猜测用户语言。

显式 locale 通过注册表中的英文语言名生成稳定运行约束，例如 `ja-JP` 生成
“Use Japanese for user-visible output”。代码、证据和日志仍保持原文。

### Language selection

设置页语言选择器展示每种语言的自称名称，例如 `Deutsch`、`日本語`、`繁體中文`。列表按
注册表定义的稳定产品顺序展示，不随当前界面语言重新排序，避免切换后焦点位置跳动。

选择过程：

1. 用户选择新语言；
2. 当前页面保持可操作，异步加载新目录；
3. 目录结构与 placeholder 验证通过后保存当前 workspace 设置；
4. 保存成功后一次性提交目录、locale、`<html lang>` 与 `<html dir>`，再报告给 Desktop；
5. 加载或保存失败时保留原语言并显示可恢复错误，不写入失败值。

### Initial locale resolution

启动时按以下优先级解析：

1. 当前 workspace 的有效 locale；
2. 旧版 `ling-stack.locale` 本地值，用于一次性迁移；
3. `navigator.languages` 或 Electron `app.getLocale()` 的第一个可支持匹配；
4. `zh-CN`。

已有 `en-US`、`zh-CN` 设置原样保留。未知或已经撤销支持的 locale 不覆盖持久化数据，运行时
回退 `en-US` 并记录诊断。

## Architecture

### Shared locale registry

新增 `@ling-stack/localization`，只包含平台无关数据和函数：

```ts
export const SUPPORTED_LOCALES = [/* 55 BCP 47 tags */] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleDescriptor {
  readonly locale: SupportedLocale;
  readonly nativeName: string;
  readonly englishName: string;
  readonly direction: "ltr" | "rtl";
  readonly aliases: readonly string[];
  readonly responseInstructionName: string;
}
```

共享包提供：

- `isSupportedLocale(value)`；
- `normalizeLocale(value)`；
- `matchSupportedLocale(navigator.languages)`；
- `localeDescriptor(locale)`；
- `responseLanguageInstruction(locale)`；
- locale-aware number/date/list/relative-time formatter 工厂。

注册表是唯一语言集合来源。Web、Contracts、Core、Daemon 和 Desktop 不得复制语言数组。

### Message identity

新文案使用稳定、带域前缀的 message ID：

```text
common.action.cancel
settings.language.interface
conversation.approval.allow_once
desktop.daemon.start_failed.title
```

message ID 只描述语义，不包含英语文案，也不因措辞调整而变化。源目录 `en-US` 保存默认文案和
开发注释。

现有 `t("English copy")` 与少量中文 key 通过 legacy catalog 保持兼容。迁移器为活跃旧 key
生成稳定 ID 映射；调用点按功能域逐步迁移。兼容层在所有活跃调用迁移后删除，不能永久允许新
代码继续增加自然语言 key。

### Catalog source and generated output

当前可编辑目录使用平铺 JSON，避免运行时再解析第二套 source/translation schema：

```text
packages/localization/catalogs/en-US.json
packages/localization/catalogs/<locale>.json
packages/localization/catalogs/additional-source.json
packages/localization/catalogs/additional-zh-CN.json
```

每个 locale 文件保存：

- locale 和全目录 `sourceRevision`；
- 每个 message 的 `sourceHashes`；
- `messages` 字典。

`en-US.json` 是确定性源目录。`additional-source.json` 与 `additional-zh-CN.json` 承载不在旧 Web
字典中的 Desktop、Daemon 与 terminal report 文案，`i18n:import-legacy` 将它们与现有 Web 字典合并。
其他 locale 只复用 source hash 仍匹配的翻译，因此新增或修改文案不会重翻整个目录。

编译输出位于包的 `dist/generated/catalogs/<locale>.js`，loader 位于
`dist/generated/catalog-loaders.js`，均由构建生成且不手工编辑。运行时只加载当前 locale chunk
与 `en-US` fallback chunk。

### Formatting

当前目录格式支持命名参数替换，例如 `{count}`，并在构建门禁中校验源文案与译文参数集合一致。
它尚未实现 ICU MessageFormat 的 plural/select 语法，因此合同不得声称已经具备完整 ICU。数量、
日期、相对时间和列表使用平台 `Intl`：

- `Intl.NumberFormat`；
- `Intl.DateTimeFormat`；
- `Intl.RelativeTimeFormat`；
- `Intl.ListFormat`；
- `Intl.PluralRules`（需要显式复数分支的调用点）。

源消息与翻译必须拥有相同参数集合。运行时只进行文本参数替换，不解释 HTML。完整 ICU 支持若
后续引入，必须先迁移目录 schema 和编译器，并新增 plural/select 的逐语言测试。

### Web loading

Web I18n Provider 保留 `useI18n()` 和 `t()` 形态，减少调用面变化，但内部改为：

- 由 locale registry 验证和匹配；
- `import.meta.glob` 或生成 loader map 动态导入目录；
- 切换期间保留旧目录，避免闪白或布局抖动；
- 失败时不提交设置；
- 开发模式缺失 key 显示显眼 marker 并报告；
- 生产模式按 locale -> `en-US` -> message ID 回退。

已声明支持的 55 个 locale 发布门禁不允许依赖英文回退。英文回退只处理损坏包或未来未知 key。

### Daemon and contracts

Contracts 的 `ResponseLanguage` 扩展为共享 `SupportedLocale` 的语义别名，持久化仍是字符串，
不新增表或列。

Daemon：

- 接受 55 个显式回复 locale；
- 频道、普通会话和私聊使用同一注册表验证；
- `follow_user` 不再压缩为中英文；
- 用户可见错误优先返回结构化 code 与参数；
- 必须写入 transcript 的兜底文本使用请求明确 locale；无明确 locale 时使用英语安全兜底；
- terminal report、proposal、workflow fallback 等二分支文案迁入共享服务端目录。

### Desktop

Desktop 使用 Web 已确认的 interface locale，并保持 Electron 系统 locale 只作为首次匹配输入。

以下表面必须接入共享目录：

- 主窗口中的 Web UI；
- Computer Use preview；
- daemon 启动、恢复和不兼容原生对话框；
- Desktop 自定义菜单、通知和权限说明；
- 打包后离线运行的所有 locale chunk。

Desktop 不依赖在线下载语言包。`electron-builder` 必须将 55 个编译目录、共享 locale registry
和目录 source revision 一并打包。

## Translation Workflow

### Developer flow

新增或修改产品文案的标准流程：

```bash
corepack pnpm i18n:import-legacy
corepack pnpm i18n:translate --locales all --batch-size 40 --concurrency 8 --delay-ms 100
corepack pnpm i18n:check
corepack pnpm i18n:compile
```

- `import-legacy` 合并 Web 字典与 `additional-*` 同步目录；
- `translate` 只处理缺失或 source hash 过期项；
- `check` 是确定性门禁，不调用网络或模型。
- `compile` 生成按 locale 动态加载的模块，以及 Daemon/terminal report 使用的同步子目录。

翻译前，placeholder、反引号内容、URL 和锁定产品词会替换为 `__0__`、`__1__` 形式的数字
哨兵。译后必须逐项恢复并验证出现次数。整句重试仍失败时，工具按 token 边界分段；某个纯文本
段连续返回空值时，再按最近单词边界递归翻译并确定性拼回。旧 XQZ 和 PUA 哨兵只保留恢复
兼容，不再用于新请求。

翻译生成工具不进入产品运行时，不发送用户消息、workspace 内容或日志。`check` 与 `compile`
完全离线；翻译 provider 不在 CI 或产品运行时调用。

### Quality gates

每个 locale 必须通过：

- key 集合与源目录一致；
- source hash 当前有效；
- placeholder 名称和数量一致；
- 不含未替换 marker；
- 非英语目录不得大比例原样复制英文；
- 翻译阶段锁定 token 的名称和出现次数一致；
- JSON 和编译输出确定性；
- 语言包能被 Web 与 packaged Desktop 动态加载。

## Accessibility And Layout

- `<html lang>` 必须匹配活动 locale；
- `<html dir>` 来自注册表，当前 55 个 locale 均为 `ltr`，基础设施仍保留方向字段；
- 语言选择器可键盘操作，并使用语言自称作为可访问名称的一部分；
- 不以固定宽度容纳按钮文本；稳定图标按钮尺寸不因翻译改变；
- 使用伪本地化 locale `en-XA` 做 35% 文本扩展测试，但不暴露给用户；
- 使用 `ar-XB` 做 RTL 结构测试，但不宣称 Arabic 已发布；
- 截图重点覆盖德语、法语、日语、韩语、印地语、泰语、繁中、西语和葡语。

## Privacy And Security

- 语言偏好仅存储 BCP 47 标签，不属于敏感数据；
- 翻译工具只发送公开产品源文案，不发送用户消息、workspace 内容、日志或凭据；
- 运行时不调用第三方翻译服务；
- 翻译内容不得改变审批、安全、权限或工具语义；
- 权限和高风险操作文案必须通过锁定 token 校验与语义回归，不能仅凭字符串存在即验收。

## Non-Goals

- 不把 Electron 自带 65 个 native menu locale 全部标为 Ling 产品支持；
- 不翻译用户内容、Agent 历史、代码和第三方输出；
- 不在运行时自动调用翻译 API；
- 不因多语言增加数据库表；
- 不在本轮新增移动端验收；
- 不以“可以切换但仍显示英文”作为该 locale 完成。

## Acceptance Criteria

1. 注册表精确包含 55 个产品 locale，Web、Daemon、Desktop 无复制数组。
2. 界面语言和 AI 回复语言可独立选择和持久化。
3. 55 个 Web locale 均能切换、刷新后保持，并完整显示对应语言目录。
4. 55 个显式 AI 回复 locale 可通过 Contracts、Daemon 和会话/频道运行快照。
5. `follow_user` 不再把非中文输入一律定义为英文。
6. 55 个目录通过 key、revision、source hash、placeholder、空值和保护标记门禁。
7. 首屏只加载当前目录和英语 fallback，不同步打包全部目录到主 chunk。
8. Computer Use preview 与 Desktop 原生错误对话框不再只有中英文分支。
9. macOS packaged app 离线包含所有目录，并逐 locale 验证真实设置切换。
10. 语言切换不会改变主题、权限、模型、频道、会话草稿或用户数据。
11. Web 和 packaged Desktop 的逐语言验证产物绑定到同一源提交和构建。
12. CI 阻止缺失、过期、占位符错误、未登记动态 key 和新增可见硬编码文案。
