# Internationalization Language Parity Implementation Plan

Status: implemented; final evidence is generated from the clean document commit
Owner: Web, Desktop, Daemon, localization, and release maintainers
Last verified: 2026-08-28
Document type: full-flow implementation design
Product contract: [Ling Internationalization And Language Parity](./internationalization-language-parity.md)
Base commit: `738018f17a2ec3eac4e16dd5e822f943feefb8af`
Implementation branch: `codex/codex-language-parity`

## Objective

在 PR #474 的最新本地头提交上实现 Codex 主产品层同范围的 55 种语言。交付必须覆盖文档、
共享类型、Web、Daemon、Desktop、翻译生成工具、CI、逐语言 Web 验收和 macOS 打包后逐语言
验收。

本计划完成的判定不是“代码可编译”或“语言下拉有 55 项”，而是每个 locale 都有完整目录，
切换后的真实界面和 packaged app 均使用该目录。

## Current Baseline

基线检查结果：

- PR 分支工作树干净，HEAD `738018f1`，已包含当时最新 `origin/main`；
- Web `Locale` 仅为 `en-US | zh-CN`；
- Web 字典约 `en-US=276 KB`、`zh-CN=380 KB`；
- `check:i18n` 报告 `en-US=4457`、`zh-CN=6316`、literal keys `3676`、dynamic calls `439`；
- 当前检查只保证部分中文覆盖和无重复，不检查全部 locale、ICU、placeholder 或 stale source；
- `resolveInitialLocale()` 对所有非中文浏览器仍回到 `zh-CN`；
- Settings 中 interface language 与 response language 都硬编码中英文 option；
- Contracts/Core/Daemon 将 `ResponseLanguage` 固定为中英文；
- Computer Use preview 和 Electron message box 维护独立中英字典/条件分支；
- 页面没有全局 locale direction 管理，也没有全语言打包验收。

## Current Local Evidence

截至 2026-08-28，当前实现分支的本地证据为：

- shared registry、源码目录和编译目录均为 `55/55`，每个目录 `6498` 个 key，统一
  `sourceRevision=231aa662269dd60c2a3c04d2c737d05d8c8a54d35b028fe4a3c676d22e9c1275`；
- Web 逐语言 Playwright `3/3 PASS`，每条用例内部遍历全部 55 locale；代表语言已检查明暗模式，
  长德语、西语和泰语设置导航不再裁切；
- Desktop 受影响的 Node 测试 `110/110 PASS`、renderer `28/28 PASS`、a11y `3/3 PASS`；
- macOS arm64 DMG/ZIP 构建成功，ad-hoc `.app` 通过 `codesign --verify --deep --strict`，并在隔离
  `HOME`、userData 和 Ling home 下启动到 daemon ready、Office Driver ready、主窗口 loaded；
- `corepack pnpm --filter @ling-stack/desktop verify:packaged-language-parity` 验证 `app.asar` 编译目录
  `55/55`、Web 独立语言 chunk `55/55`、英语 fallback、源码目录一致性、registry SHA、app.asar SHA
  和 app bundle tree fingerprint，报告写入 ignored
  `apps/desktop/test-results/packaged-language-parity/package-verifier.json`；
- `corepack pnpm --filter @ling-stack/desktop accept:packaged-language-parity` 使用同一隔离 userData、
  `HOME`、Ling home 和测试 workspace 完成 `55/55 PASS`。验收通过 56 次真实 packaged app 启动：
  每个 locale 均通过真实 Select 切换产品语言和回复语言，再正常关闭并重启验证持久化；所有启动
  `forcedSignal=null`，renderer error、fatal log、横向溢出和设置导航裁切均为 0，并生成 8 张
  `1440x920` 代表语言截图。每次报告写入 ignored
  `apps/desktop/test-results/packaged-language-parity/run-*/report.json`；
- 发布绑定不把变化的 commit/hash 反写进源码文档。最终权威证据是 clean HEAD 之后重新生成的
  `package-verifier.json` 和对应 `run-*/report.json`：两者的 `source.commit` 必须相同、
  `source.dirty=false`、`releaseCandidateBound=true`，且 appAsar/app bundle tree SHA 必须一致；
- packaged `.app` 的逐语言真实 UI/CDP 工程验收已经关闭；若最终 clean commit 之后的包内容、签名
  或逐语言报告任一不满足上一条，本状态自动失效，不能使用本计划的完成标记进入发布；
- 完整 Desktop 套件当前为 `1049 PASS / 24 FAIL / 33 CANCELLED / 4 SKIPPED`。本分支相关 IPC 失败
  已修复；其余失败来自既有 CUA source-build SHA 安全锚点、当前 macOS 主机上的 Windows handoff
  文件类型门禁和 CUA 并发 pending Promise，不通过修改这些安全锚点掩盖。

## Delivery Strategy

采用“兼容层先行、共享注册表收敛、目录生成、全表面接入、逐语言验收”的顺序。不得先批量生成
53 份字典，再反过来修架构；否则会翻译大量废弃 key，并使之后的每次文案修改产生 55 份手工
冲突。

最终发布前所有 slices 必须完成。内部 slice 可以单独提交，不能单独宣称多语言完成。

## Slice 0: Documentation And Evidence Baseline

### Changes

- 新增产品/架构合同 `internationalization-language-parity.md`；
- 新增本实施计划；
- 更新 `docs/design/README.md`；
- 将旧 `i18n-alignment-modularization.md` 标记为已被替代；
- 在 `docs/release/desktop.md` 增加语言包打包与验收门禁。

### Evidence

- docs links；
- `git diff --check`；
- locale 集合与本机 Codex `26.820.60940` Webview map 的只读核对记录。

## Slice 1: Shared Localization Package

### Package layout

```text
packages/localization/
  package.json
  src/
    index.ts
    locale-registry.ts
    catalog.ts
    server-catalog.ts
    formatters.ts
    generated/
      catalog-loaders.ts
      server-catalogs.ts
      catalogs/<locale>.ts
  catalogs/
    en-US.json
    <locale>.json
    additional-source.json
    additional-zh-CN.json
  scripts/
    import-legacy-web-catalogs.mjs
    translate-catalogs.mjs
    check-catalogs.mjs
    compile-catalogs.mjs
    protected-tokens.mjs
  test/
```

### Interfaces

```ts
export type SupportedLocale = ...;
export type InterfaceLocale = SupportedLocale;
export type ExplicitResponseLanguage = SupportedLocale;
export type ResponseLanguagePreference = "follow_user" | ExplicitResponseLanguage;

export function normalizeLocale(value: unknown): SupportedLocale | undefined;
export function matchSupportedLocale(values: readonly string[]): SupportedLocale;
export function loadCatalog(locale: SupportedLocale): Promise<CompiledCatalog>;
export function formatCatalogMessage(catalog: TranslationCatalog, fallback: TranslationCatalog, key: string, values?: TranslationValues): string;
```

### Tests

- 精确 55 locale snapshot；
- 无重复 locale/alias；
- exact、language、script、region 和 fallback 匹配；
- `zh-Hans`、`zh-Hant`、`es`、`pt`、`no` 等别名；
- locale descriptor 的 native name、direction 和 instruction name 完整；
- number/date/list/relative time 在代表语言下稳定。

## Slice 2: Catalog Extraction And Stable IDs

### Extraction

扩展现有 TypeScript AST 工具，收集：

- `t("literal")`；
- typed message maps；
- Desktop message definitions；
- Daemon fallback definitions；
- legacy dynamic key allowlist。

439 个动态调用必须分类：

1. 状态/角色等有限枚举：改为 typed message ID map；
2. 用户或服务端内容：不得进入 `t()`；
3. 真正动态但受控的插件文案：使用 namespaced external catalog API；
4. 无法证明来源的调用：构建失败。

### Stable ID migration

- 为活跃 key 生成 domain-based IDs；
- 维护 deterministic legacy key -> ID map；
- 当前调用点先通过兼容 `t()` 解析，不要求一次修改所有 JSX；
- 新代码 lint 禁止自然语言 key；
- 按设置、导航、会话、审批、频道、Desktop 分批迁移调用点。

### Pruning

只有在 literal、typed dynamic map、Desktop 和 Daemon 全部进入确定性源目录后，才删除未引用旧 key。
删除前输出清单，避免把动态状态误判为废弃。

## Slice 3: Catalog Toolchain

### Commands

根 `package.json` 提供当前可执行命令：

```text
i18n:import-legacy
i18n:translate
i18n:check
i18n:compile
```

### Deterministic catalogs

`en-US.json` 是源目录；每个 locale 文件包含全目录 `sourceRevision`、逐 message `sourceHashes`
和排序后的 `messages`。输出通过临时文件加原子 rename 写入，重复运行无语义 diff。

### Translation provider boundary

`translate.mjs`：

- 只读取 missing/stale source product copy；
- 按 locale 和 token 预算分块；
- 请求只包含公开源文案、目标语言和受保护 token，不包含用户或 workspace 数据；
- placeholder、URL、反引号内容和产品词使用 `__0__` 数字哨兵保护；
- 整句失败后按 token 边界降级，纯文本空值再按单词边界递归降级；
- 输出先写临时文件，通过 schema/placeholder 后原子替换；
- 按逐条 source hash 支持重试和断点续跑；
- 日志不打印凭据；
- CI 永不调用翻译 provider。

没有 provider 时工具返回明确缺口，不伪造完成。

### CI check

`i18n:check` 验证所有 shipped locale：

- exact keys；
- source hash current；
- placeholder parity；
- no TODO/marker；
- 非英语目录的英文原样复制比例门禁；
- 翻译阶段 locked token 次数校验；
- deterministic compile；
- exact 55 locale registry/catalog parity。

## Slice 4: Web Runtime And Settings

### Provider

重构 `apps/web/src/i18n.tsx`：

- 从共享 registry 取得类型；
- 异步加载 selected locale；
- 切换时保留 current catalog；
- 新 catalog ready 后原子替换；
- load error 保持旧 locale；
- 设置 `documentElement.lang` 和 `dir`；
- Desktop bridge 只接收已确认 locale。

### Persistence

- workspace locale 继续使用现有 string 字段，无 DB migration；
- 旧 localStorage 仅作一次性迁移；
- 新目录加载成功后先保存 workspace，保存成功才提交 UI；
- 加载或保存失败保留上一 locale，不产生短暂错误语言状态；
- workspace 切换加载对应 locale，不污染其他 workspace；
- 未设置时用 `navigator.languages` 匹配，无法匹配仍为 `zh-CN`。

### Settings UI

- Product language 下拉来自 registry；
- 标签使用 native name；
- AI response language 来自 `follow_user + registry`；
- 两个控件状态独立；
- 长语言名不撑破设置布局；
- 切换期间仅目标 Select 显示 busy，不锁整个页面。

### Web formatting migration

替换 `locale === "zh-CN"` 的时间、时长、数量和列表拼接，使用共享 formatter。产品语义条件不得
依赖语言字符串。

## Slice 5: Contracts, Core, And Daemon

### Contracts and persistence

- Contracts 从 shared package 导入 `SupportedLocale`；
- Core 的 response language arrays 由 registry 派生；
- JSON/SQLite 仍保存字符串；
- 旧 `zh-CN`、`en-US` 数据无迁移；
- unknown value fail closed 并产生 config diagnostic。

### Conversation and channel execution

- normal conversation、channel、private teammate 三条请求均接受 55 locale；
- run snapshot、proposal、workflow metadata 和 terminal report 保存 BCP 47；
- explicit locale 通过统一 instruction builder；
- `follow_user` 向模型传递跟随用户语言的语义，不做中英二分类；
- 用户可见 daemon error 改为 code + params，由 Web 翻译；
- 必须持久化的 fallback assistant text 从 server catalog 取得。

### Tests

- schema/parser 全 55 table test；
- 每个 locale 的 conversation/channel request round trip；
- legacy data round trip；
- invalid locale rejection；
- `follow_user` 对日语、韩语、西语输入不被强制英语；
- explicit locale instruction snapshot。

## Slice 6: Desktop Integration

### Main window and bridge

- `ComputerUsePreviewLocale` 改为 shared `SupportedLocale`；
- IPC validator 使用 registry；
- Web 报告 locale 后 preview 同步切换；
- packaged Web locale chunks 位于 `Resources/web/assets` 并可离线加载。

### Native surfaces

将以下条件分支改为 typed message IDs：

- daemon incompatibility；
- daemon startup failure；
- startup recovery；
- permission and diagnostic actions；
- Computer Use preview status/actions；
- 自定义 menu/notification copy。

Electron `app.getLocale()` 只用于初始匹配；workspace 明确选择优先。

### Packaging checks

新增 verifier：

- registry 与打包目录精确声明同一组 55 locale；
- app 中存在 55 compiled catalog chunks；
- packaged compiled messages 与当前源码目录逐项一致；
- 全部目录具有同一 source revision 和 key 集合；
- `en-US` fallback 必须存在；
- Web resources 每个 locale 只有一个独立 chunk，且包含对应 locale 与 source revision；
- 输出 source commit/dirty state、registry SHA、loader SHA、app.asar SHA 和 app bundle tree fingerprint。

## Slice 7: Initial Translation Population

### Source cleanup first

在生成 53 个新增目录前完成活跃 key 提取和废弃 key 清理。翻译目标按 `en-US` 确定性源目录，
不按旧文件总行数。

### Translation batches

按以下顺序生成，便于尽早发现 script/字体/排版问题：

1. `zh-HK`, `zh-TW`, `ja-JP`, `ko-KR`；
2. `de-DE`, `fr-FR`, `es-ES`, `es-419`, `pt-BR`, `pt-PT`, `it-IT`；
3. 印度语言与东南亚语言；
4. 欧洲其余语言；
5. 非洲语言。

每批执行 translate -> deterministic check -> representative UI smoke。最终门禁要求 55 个目录全部
`missing=0`、`stale=0`、`invalid=0`。

### Review priorities

安全和决策文案优先人工抽查：

- approval allow/deny；
- full access；
- delete/archive；
- external send/deploy；
- credential/permission；
- daemon recovery。

## Slice 8: Web Acceptance For Every Locale

新增 `apps/web/e2e/i18n-language-parity.spec.ts`，对 55 locale 参数化执行：

1. 用隔离 storage 启动；
2. 打开 Settings -> Interface；
3. 通过真实 Select 选择 locale；
4. 确认 `<html lang>`、`dir`、selected value；
5. 确认导航、设置、会话 composer、审批门和错误状态来自目标目录；
6. 刷新并确认持久化；
7. 切换回 `en-US`，确认可逆；
8. 检查 console/page errors、缺失 marker 和横向滚动。

程序化全量验收使用桌面 viewport `1440x960`。视觉截图矩阵额外覆盖：

- `de-DE`：长文本；
- `fr-FR`：长标签和标点；
- `ja-JP`, `ko-KR`：CJK 字体和密度；
- `hi-IN`, `th-TH`：复杂 script；
- `zh-TW`：繁体；
- `es-419`, `pt-BR`：区域变体；
- `en-XA`：伪本地化扩展。

每个 locale 结果写入当前 worktree 的 ignored `apps/web/test-results/i18n-language-parity/`，包含 locale、
source SHA、catalog SHA、状态、console errors 和截图路径。

## Slice 9: Packaged macOS Acceptance For Every Locale

### Build

从 clean source commit 运行：

```bash
corepack pnpm --filter @ling-stack/desktop package:mac
codesign --verify --deep --strict "apps/desktop/release/mac-arm64/Ling Stack.app"
```

`unsigned_dev` 在 Fuse 修改后执行 ad-hoc 签名，只用于工程验收，不替代 Developer ID/notarization。

### Isolated launch

测试使用独立 `userData` 与测试 workspace，不读取或覆盖用户正式配置。启动 packaged `.app` 的实际
主执行文件，并通过允许的测试 bridge/CDP 接入真实窗口。

### Per-locale flow

对 55 locale 逐项：

1. 打开 packaged app；
2. 进入 Settings；
3. 真实选择目标 Product language；
4. 验证主窗口立即切换；
5. 打开会话、频道和 Computer Use preview 测试表面；
6. 验证 Desktop locale IPC 与 preview catalog；
7. 重启 packaged app；
8. 验证 locale 保持且离线目录加载成功；
9. 切换下一个 locale；
10. 记录 console、main process error、catalog hash 和截图。

原生 message box 不通过批量弹 55 次阻塞自动化；其 translator 对 55 locale 做 table test，并对
`en-US`、`zh-CN`、`de-DE`、`ja-JP`、`hi-IN`、`zh-TW` 运行可视 smoke。

验收产物写入 ignored `apps/desktop/test-results/packaged-language-parity/`，绑定 app bundle
fingerprint、source SHA 和 catalog source revision。

## Full Test Matrix

### Deterministic

```bash
corepack pnpm i18n:check
corepack pnpm --filter @ling-stack/localization test
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop test
corepack pnpm --filter @ling-stack/desktop verify:packaged-language-parity
corepack pnpm --filter @ling-stack/desktop accept:packaged-language-parity
git diff --check
```

### Runtime

- 55-locale Web Playwright；
- representative screenshots in light/dark；
- 55-locale packaged macOS Playwright/CDP；
- Desktop native translator table tests；
- offline packaged catalog load；
- console/page/main-process error scan；
- no horizontal overflow；
- no missing ID marker；
- locale switch does not mutate model/theme/permission/draft/channel state。

## CI Changes

- `check:i18n` 替换为 shared full-catalog check；
- Linux CI 运行 55 locale Web smoke；
- macOS artifact workflow 运行 package catalog verifier 和代表 locale smoke；
- 完整 55 locale packaged acceptance 可在 release candidate workflow 运行；
- 翻译 provider 不在 CI 运行；
- 缺失或 stale 翻译直接阻止合并。

## Rollback

- 保留旧 `en-US`/`zh-CN` catalog 的最后一份确定性生成物作为一个版本回滚输入；
- locale registry 和 catalog source revision 同一提交发布，禁止分别回滚；
- 新 locale 出现运行时损坏时可从 registry 暂时撤销，但不得保留可选项后静默英文回退；
- 数据中已有 locale 值不删除，重新支持后可恢复；
- 回滚不修改用户其他 workspace settings。

## Hard Stops

遇到以下任一项不得宣称完成或进入发布验收：

- 任一 shipped locale `missing > 0` 或 `stale > 0`；
- 任一 locale 只能显示英文 fallback；
- 439 个 dynamic calls 仍有未分类入口；
- packaged app 缺任一目录或只能联网加载；
- interface locale 改动 response language；
- 非中英文输入的 `follow_user` 被强制为英文；
- Desktop preview 或 native recovery 仍只有中英文条件分支；
- 只测试代表语言，没有逐项测试全部 55 locale；
- 打包验证使用 dev server 而不是 packaged `.app`。

## Completion Evidence Checklist

- [x] 两份设计文档和索引更新；
- [x] shared registry 与 55 locale unit snapshot；
- [x] exact catalogs `55/55`；
- [x] missing/stale/invalid `0/0/0`；
- [x] Web runtime dynamic loading；
- [x] independent interface/response settings；
- [x] Contracts/Core/Daemon 55 locale；
- [x] Desktop preview/native catalog；
- [x] Web per-locale result `55/55 PASS`；
- [x] packaged macOS per-locale result `55/55 PASS`；
- [x] package catalog verifier PASS；
- [x] relevant typecheck/lint/unit/build PASS；
- [x] `git diff --check` PASS；
- [x] evidence binding contract implemented；最终状态由 clean HEAD 后生成的两个 ignored report 判定。
