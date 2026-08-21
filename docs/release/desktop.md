# Ling Desktop 发布验收手册

本文是 Desktop Computer Use PiP 的发布门禁唯一操作清单。它把“本地工程基线”和
“真实平台发布证据”分开，避免把 fake source、unsigned 包或 provider 下载校验误报为
跨平台完成。

当前内部产品包使用
[Cua Driver Self-Hosted Native Runners](./cua-driver-self-hosted-runners.md) 中的仓库专用、
手工 dispatch 路径。`Desktop product artifacts` 每次只能选择 `macos-arm64` 或
`windows-x64`，同平台只执行一次锁定源码构建，随后直接进入 Ling 产品打包。它不再运行
A/B、promotion/finalizer、fixture-retention 或跨 job artifact 中转；最终 artifact 只含该
平台安装包和 `checksums.txt`。这条内部工程路径不替代公测前的 notarization、
SmartScreen/WDAC 或 Windows 真机验收。

Windows provider、签名、安装范围和回滚决策见
[Desktop Windows 发布决策记录](./desktop-windows-release-decisions.md)。

Windows bundled target 使用两条独立判定轴：`bundled_embedded` 表示 helper 是否由
`Ling Stack Setup.exe` 安装到 Ling 私有资源目录并由 Electron main 托管；
`signingTier` 表示候选最多能得到什么结论。

| `signingTier` | `distributionChannel` | 允许的结论 |
| --- | --- | --- |
| `unsigned_dev` | `development` | 工程验证，不得晋级 |
| `test_signed_internal` | `internal` | `INTERNAL_TEST_PASS`，固定 `releaseReady=false` |
| `production_signed` | `production` | 完整生产门禁后才可 `RELEASE_PASS` / `releaseReady=true` |

## 支持矩阵

| 平台 | 目标 | 当前证据边界 |
| --- | --- | --- |
| macOS | Apple Silicon arm64 | Intel Mac 不支持；本地 provider-bearing DMG 已用锁定 tag/Cargo.lock、patches 1-4 和 Apple Development 身份构建并通过 bundled/coexistence smoke。Developer ID、notarization、clean-machine TCC、升级回滚仍是公开发布门禁 |
| Windows | x86_64 | source build、私有 `ling-cua-driver.exe` 布局、Setup 打包和跨平台契约已实现；当前产品 workflow 生成 `unsigned_dev + development` Setup，Windows 同事负责真机安装/共存/卸载验收。正式 Authenticode、Publisher、SmartScreen/WDAC 仍是公开发布门禁 |
| Windows ARM64 | 不支持 | 不生成安装包或 provider payload |
| Linux | 不支持 | provider gate 必须 fail closed |

## Chrome Native Messaging Host 发布边界

Desktop 从 Chrome 扩展 `0.1.1` 起同时分发当前平台的 `Ling Browser Host`。Host 名称固定为
`com.lingstack.browser`，只负责 Chrome Native Messaging 长度帧与 daemon 私有 loopback
broker 之间的转发，不包含工作区选择、浏览器业务命令、模型调用或审批逻辑。

每个 Desktop 候选必须把 Host 纳入与主应用相同的源提交和发布证据：

- macOS arm64：Host 位于 `.app/Contents/Resources/browser-host/`，具有可执行权限，包含在
  Developer ID/hardened runtime 的逐 Mach-O 校验中；启动后幂等写入用户级 Chrome 与
  Chromium `NativeMessagingHosts` manifest。拖拽删除应用后，残留 manifest 不得包含凭据，
  且只能指向已不存在的应用内路径。
- Windows x64：Host 位于安装目录的私有 `resources\\browser-host` 下，纳入 app/NSIS
  hash 与 Authenticode 分层验证；启动后写入用户级 manifest 和 HKCU Chrome/Chromium
  注册表。NSIS uninstall 必须删除 Ling 自己的两个注册表项和 manifest，不能触碰其他 Host。
- 源码模式：`ling-stack browser-host install|status|uninstall` 是唯一受支持的开发 Host
  生命周期入口；不得要求用户在扩展中填写工作区、daemon URL 或配对码。

打包测试必须验证 Host 版本、Native 协议、扩展版本、extension ID、Host SHA、扩展
manifest SHA、扩展 ZIP SHA 与 source commit 一致。macOS 本机结构检查或 Windows
self-hosted 构建不能替代 Developer ID/notarization、Authenticode/SmartScreen 和 clean-host
安装/升级/卸载验收。

开发阶段仓库为 private，不启用应用自动更新。公开后使用 GitHub Releases；无需改变安装包
身份，只需在 release workflow 发布现已保留的 updater companion assets。最终用户可见文件：

```text
Ling-Stack-<version>-macos-arm64.dmg
Ling-Stack-<version>-windows-x64-setup.exe
checksums.txt
```

未来 updater companion assets：

```text
Ling-Stack-<version>-macos-arm64.zip
latest-mac.yml
Ling-Stack-<version>-windows-x64-setup.exe.blockmap
latest.yml
```

产品 workflow 已要求 macOS 和 Windows 包携带锁定的 Ling source build 和
version-isolated provider state contract；权限与验收状态不会写入安装包。macOS 本地验收
已完成，Windows 真机验收仍未完成，因此不能把 Windows 写成已验收能力。
Windows 上游参考基线为：

```text
trycua/cua  cua-driver-rs-v0.8.3
SHA-256      6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0
```

该上游 release 当前为 `prerelease=true`，审阅的两个 Windows provider executable 均无
PE certificate table。它只能进入 `internal` channel 验收，公开发布风险和签名责任必须按
Windows 发布决策记录显式关闭。

## 每次提交的本地基线

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
corepack pnpm --filter @ling-stack/browser-host test
corepack pnpm --filter @ling-stack/browser-host build:native
corepack pnpm --filter @ling-stack/desktop verify:release-schemas
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/daemon test
node --test apps/desktop/tests/*.test.mjs
node --test \
  packages/contracts/test/computer-use.test.mjs \
  packages/api-client/test/computer-use.test.mjs \
  packages/daemon/test/computer-use-api.test.mjs \
  packages/daemon/test/computer-use-producer.test.mjs \
  packages/daemon/test/computer-use-registry-retention.test.mjs \
  packages/daemon/test/computer-use-run-integration.test.mjs \
  packages/daemon/test/cua-driver-preset.test.mjs \
  packages/daemon/test/cua-driver.test.mjs \
  packages/daemon/test/provider-health.test.mjs \
  packages/daemon/test/plugin-manager-api.test.mjs
corepack pnpm --filter @ling-stack/desktop exec playwright test --config tests/playwright.renderer.config.mjs
corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/app-shell-selectors.spec.ts e2e/desktop-computer-use-bridge.spec.ts e2e/workspace.spec.ts
node apps/desktop/tests/run-computer-use-smoke.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
node apps/desktop/tests/run-computer-use-smoke.mjs --real
node apps/desktop/tests/run-computer-use-smoke.mjs --display
corepack pnpm --filter @ling-stack/desktop performance:computer-use:real
corepack pnpm --filter @ling-stack/desktop exec electron tests/screenshot-app
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/desktop-artifacts.yml
git diff --check
```

2026-07-17 当前 worktree 的 final pre-commit 本地矩阵通过：Desktop Node **291/291**、
PiP renderer **20/20**、Web E2E **35/35**、contracts **5/5**、API client **48/48**、
full daemon **629/629**、macOS release-focused **28/28**、Windows
acceptance/provider/release focused **57/57**。严格 Ajv Draft 2020-12 校验器通过当前固定
集合的 **11/11** release-evidence schemas，并执行 macOS verdict/performance 正负实例。
Desktop production build、Web production build/typecheck/lint/i18n、workspace typecheck/lint
和 actionlint 也全部通过。当前 Desktop product artifact workflow 仅允许手工 dispatch；
PR 和 `main` push 不会自动消耗 native runner 或 artifact 配额。

这组数字是最终提交前当前 diff 的本地工程证据，不是 candidate 或跨平台 release closure。
下方固定 unsigned artifact hash 仍明确标为 `baseline @ e20777f5`，最终候选必须重新生成
hash。上述结果不替代 Developer ID/notary、clean-host TCC/capture-indicator/VoiceOver、Windows
interactive VM/provider/DPI/双屏/SmartScreen/Narrator/NVDA、hosted signed CI、clean-machine
安装生命周期、外部 detached signatures 或真实 candidate daemon provenance 证据。

默认性能 harness 是 fake-source baseline；`performance:computer-use:real` 补充当前
主机 development Electron 的十次 Show/Hide churn、隐藏 idle 基线和 30 秒连续采集
per-process track/CPU/working-set 测量。两者都不能替代签名候选的 TCC、capture
indicator、WGC、UIA、provider 进程或 release-budget 证据。报告中的生命周期
`verdict.pass` 只证明测量和清理完成；发布还要求签名候选上的
`releaseBudgetComparison.pass=true`。

2026-07-16 最终 current-host real MediaStream 结果：首个 decoded frame p50/p95 为
**168.09 / 177.84 ms**，Hide-to-release p50/p95 为 **2.16 / 3.65 ms**；30 秒 active
preview 相对 hidden-idle 的单核 CPU delta 为 **0.21%**，working-set overhead 为
**11,763,712 bytes**；十次 Show/Hide churn 为 **6.04%** main-process CPU 和
**17,661,952 bytes** app working-set growth。fake ownership/crash lane 的 p95 为
**415.27 ms**。十二次 capture activation 对应十二次
source enumeration，复用一个 renderer document，`applyConstraints()` 调用为 **0**；
最终 window、renderer、process、track、timer、subscription、IPC、adapter source 和
raw listener residue 均为 **0**。这是当前机器 development runtime 的预算对照，不是
签名发布证据。

## macOS unsigned 工程包

```bash
corepack pnpm --filter @ling-stack/desktop package:mac
hdiutil verify 'apps/desktop/release/Ling-Stack-0.0.0-macos-arm64.dmg'
unzip -t 'apps/desktop/release/Ling-Stack-0.0.0-macos-arm64.zip'
```

unsigned job 必须验证：

- `CFBundleIdentifier=com.lingstack.desktop`；
- `CFBundleIconFile=icon.icns`，且 arm64 bundle 内图标与提交的 Ling icon 字节一致；
- main executable 和 embedded provider 都只能是 arm64 Mach-O；
- 当前 baseline 的 bundled Cua Driver 只有 manifest、MCP metadata、README；切换到
  embedded macOS target 前，workflow 必须改为验证 exact source/patch/toolchain lock、
  post-sign provider seal、binary、license、架构、exact entitlements、state isolation 和
  无 standalone app/updater script，而不能继续沿用本断言；
- 不存在 Developer ID Authority 或 Team ID；
- fake、real-window、primary-display packaged provenance smoke 在 arm64 `.app` 以及挂载后的
  DMG 中通过；
- Cua native-window handoff 在 dev Electron 和 arm64 packaged `.app` 中通过：
  Electron source ID 只作为测试 oracle，交给 Ling descriptor 的只有 Cua provider
  PID 和 `nativeWindowId`，不得按标题、前台窗口或 z-order 选择。

这类包只能作为工程候选包，不能作为 Gatekeeper 或 TCC 发布证据。

历史 universal/x64 baseline hash 不再是候选依据。每次 workflow 都必须从最终 DMG 与
Setup.exe 重新生成统一 `checksums.txt`；不能复用旧文件名或旧 SHA-256。unsigned 包只用于
工程验证，不能写成签名、notarization、SmartScreen 或发布结论。

## macOS signed release

只有拿到 Developer ID identity、Team ID 和 notarization 凭据后才能运行：

```bash
codesign --verify --deep --strict 'apps/desktop/release/mac-arm64/Ling Stack.app'
spctl -a -vv 'apps/desktop/release/mac-arm64/Ling Stack.app'
xcrun notarytool submit <artifact> --wait
xcrun stapler validate 'apps/desktop/release/mac-arm64/Ling Stack.app'

node apps/desktop/tests/verify-macos-signed-candidate.mjs \
  --team-id <TEAM_ID> \
  --bundle-id com.lingstack.desktop \
  --app 'apps/desktop/release/mac-arm64/Ling Stack.app' \
  --dmg 'apps/desktop/release/Ling-Stack-<version>-macos-arm64.dmg' \
  --zip 'apps/desktop/release/Ling-Stack-<version>-macos-arm64.zip' \
  --output apps/desktop/test-results/macos-signed-candidate.json
```

verifier 会逐 Mach-O 检查 Developer ID、Team ID 和 hardened runtime，并只读挂载/解包
DMG、ZIP，重新验证其中唯一 Ling app，再把 arm64 main executable、bundle
tree fingerprint 和 CDHash 绑定到 standalone app。缺 arm64 app、DMG、ZIP，出现额外
Intel-only/universal 候选，或归档内 app 不一致时不得产生
`signedCandidateEvidence=true`。报告中的 artifact path 一律相对 candidate report 所在
目录；复制到 clean host 时必须保留 report 与 `release/` 树的相对布局，不能依赖 signing
host 的绝对路径。

签名矩阵必须在 dedicated clean machine 覆盖：Screen Recording denied、prompt、granted、
revoked 后 re-granted，
窗口捕获、display 捕获、source ended、descriptor revision、Desktop restart、track
释放和系统 capture indicator。脚本不得调用 `tccutil`；人工授权变化必须在同一 case
结束前恢复到 granted，并记录完整转换顺序。

每个 TCC case 使用 `run-macos-tcc-acceptance.mjs` 生成独立 JSON。provider lock 中的
macOS 13/14/15/26 × arm64 每个 cell 都必须生成
denied/prompt/granted/revoked 四份，初始矩阵共 16 份。report 必须同时记录完整
`host.macosVersion` 和规范化 `host.macosMajor`；finalizer 从实际 `sw_vers` 结果重算 major，
并校验 major、host architecture、实际执行架构和 candidate executable SHA。单一 host
或单一 OS 不能替另一 major 关门。脚本会在目标 host
重新执行完整 signed-candidate verifier，而不是信任可编辑报告中的 PASS。`granted`
必须带该 cell 独立的 window/display capture-indicator、AX、AppKit input、
Chromium/Electron background input、cursor 和 SkyLight behavior 证据，运行两个真实
smoke，并以同一个 signed executable 连续完成两次 Desktop launch/recovered
projection。`revoked` 先运行：

```bash
node apps/desktop/tests/run-macos-tcc-revocation.mjs \
  --executable '<Ling Stack executable>' \
  --signed-candidate-report '<candidate.json>' \
  --operator '<name>' \
  --capture-indicator-evidence '<revocation recording>' \
  --output '<revocation-macos-major-architecture.json>'
```

runner 启动 signed display capture 并输出 READY；操作员在 System Settings 撤权并等待
系统 capture indicator 清除后按 Enter。Desktop 随后机器观察 source ended/permission
failure、runtime 未 Stop 和 `stopRequestCount=0`。随后操作员在同一 cell 重新授权，
Desktop 必须重启 child，重新完成 health、live capture 和 background input smoke，才可
结束 case。目标 revocation schema 从现有两阶段扩为 ordered 三阶段证据，绑定同一
candidate/cell 的 active -> revoked -> re-granted/recovered 时间线、capture indicator
清除与恢复、child generation 变化和 capability 恢复。任何阶段缺失、乱序或
setup/probe/smoke 异常仍须原子写出 `verdict=FAIL` 报告。

每个架构还必须生成 packaged signed performance：

```bash
node apps/desktop/tests/run-macos-signed-performance.mjs \
  --executable '<Ling Stack executable>' \
  --signed-candidate-report '<candidate.json>' \
  --output '<signed-performance-arm64.json>'
```

producer 在同一 signed executable 上交替运行 fake baseline 与 real capture，读取本地
first-frame telemetry，并在稳定 hold 阶段采样进程 CPU/RSS。输出包含 candidate、
executable、host、producer script hash、三轮以上 raw logs 和 release budget comparison。

所有 macOS 机器证据先由 finalizer 形成不可自证的 review bundle：

```bash
node apps/desktop/tests/finalize-macos-signed-acceptance.mjs \
  --input <macos-evidence-manifest.json> \
  --output apps/desktop/test-results/macos-signed-acceptance.json
```

finalizer 会重新运行完整 candidate verifier，读取并重算所有 nested SHA-256，按
`macOS major + execution architecture` 验证 16 份 TCC 的 permission semantics、
host/execution cell、smoke/restart/revocation/provider logs，并把 capture-indicator refs
绑定到每个 cell 的 granted case。manifest、schema 和 finalizer 必须拒绝 report
path/digest 跨 cell 复用、major 缺失/不匹配和 coverage 缺口。当前仅按 architecture
索引且只识别两阶段 revocation 的 finalizer 不足以关闭 bundled provider gate；升级后
还必须验证每个 cell 的 revoked -> re-granted 顺序、child restart 和 recovered
capability。每个 DMG/ZIP 都必须有
`notarytool` `Accepted` JSON log，其 job id 与 artifact SHA 绑定；signed performance 也须
在 arm64 候选上绑定 candidate executable、producer 和 raw cycle logs。最终报告结构见
[macOS signed acceptance schema](./evidence/macos-signed-acceptance.schema.json)。本地
finalizer 固定输出 `MANUAL_REVIEW_REQUIRED`，即使调用方传入一个声称 trusted 的 callback
也不能升级为 PASS，且本地输出不得携带未验证 attestation。最终 promotion 必须由独立进程
重新计算 evidence digest，并使用发布策略固定的 reviewer key 验证 detached signature；
schema 要求 PASS 同时具备 attestation、`trusted_external_signature`、verifier 和 key ID。
手填 `PASS/true` 或只提供格式正确的 `{path, sha256}` 不构成发布证据。

macOS release harness 会把每个参与脚本绑定到记录的 harness commit Git blob、当前工作文件
bytes 和 SHA-256；即使文件被标记为 `assume-unchanged`，本地 bytes 与 commit blob 不一致
也会 fail closed。TCC、revocation、signed-performance producer 还必须绑定其调用的 candidate
verifier，finalizer 对三类报告执行相同依赖闭包检查。这个本地绑定已经完成，但不替代上面的
外部 detached-signature reviewer。

## Windows provider 和 artifact

### 当前 external/unsigned baseline

先在临时目录验证 provider，不执行上游 installer、不改全局 PATH：

```powershell
node apps/desktop/tests/verify-windows-cua-driver-provider.mjs `
  --output-dir "$env:RUNNER_TEMP\ling-cua-driver-rs-v0.8.3"
```

在已解锁的 Windows x64 interactive session 中，再运行真实 smoke：

```powershell
corepack pnpm --filter @ling-stack/desktop smoke:computer-use:windows-provider
```

它必须真实调用 `health_report`，并按 exact PID 获取唯一 HWND，再验证：

1. descriptor → Electron `window:<HWND>:...` source mapping；
2. 首帧、Hide、Show；
3. descriptor revision replacement，旧窗口 ended 不得影响新窗口；
4. 目标窗口关闭后进入 bounded stalled，runtime 不得被 Stop；
5. Desktop restart、DPI、双屏、最小化和 protected/capture-excluded 窗口行为。

Windows hosted runner 的 unsigned NSIS/fake smoke 只能证明打包，不得关闭上述 VM gate。
workflow 同时要求 unpacked smoke、静默安装、installed smoke 和静默卸载；只有 hosted
run 真正执行后才形成 installer evidence，仍不能替代 interactive provider VM。
provider 本身的 Authenticode/SmartScreen 状态必须单独记录；Ling 不得把 archive SHA 或
PE 架构校验写成签名结论。

unsigned hosted workflow 会在安装/卸载后运行诊断性 `Preflight` 并上传 JSON。缺双屏、
NVDA 或签名时状态保持 `BLOCKED`，但不会让 unsigned job 因预期阻塞失败；真实残留或
内部矛盾证据仍返回失败。`Preflight.summary.status=PASS` 也绝不等于 Full release PASS。

### Bundled target profiles

目标 Windows Setup 只安装 Ling。`cua-driver.exe` 作为版本化私有 helper 位于安装后的
`resources/providers/.../payload/`；不注册第二个应用、不加入 PATH、不创建开始菜单项或
服务，也没有独立卸载器/更新器。验收必须检查最终 Setup payload、安装后绝对路径和
Electron 实际 spawn path；runner 临时目录里的 provider 不算 bundled。

- `unsigned_dev + development`：允许验证 source build、final-byte seal、资源布局和显式
  dev 启动；无可信 catalog，也没有 promotion verdict。
- `test_signed_internal + internal`：由外部 harness 在隔离 VM 预置信任根，用真实
  Authenticode 签 installer/app/uninstaller/provider/catalog，运行完整标准能力、MCP、Job
  Object、安装/升级/卸载功能验收；最多输出 `INTERNAL_TEST_PASS`，并保持
  `releaseReady=false`。
- `production_signed + production`：从同一批准的干净 pre-sign payload 重新生成并使用
  正式 Publisher/证书/RFC 3161 policy；禁止覆盖、追加或直接晋级 test-signed PE。只有
  这条 profile 可以进入 public promotion。

测试根/PFX 绝不能进入 Ling Setup，也不能由 Ling 导入用户 trust store。harness 对
`ephemeral-ci` 每个 job 删除测试根或回滚 VM；`managed-internal` 只允许由外部 PKI 管理在
专用隔离 QA image/VM 中，不能进入通用镜像或生产链。candidate 自报 tier/channel 不可信，
verifier 必须从 governed installer/installed-main-PE/uninstaller/provider/catalog tuple 的
实际签名链派生最低等级。internal/production tuple 中的混签、双签、test root 进入
production、未签 governed member 或 provider 私有 payload 内意外 executable 都 fail
closed；development tuple 必须让所有预期 governed PE 派生为 `unsigned_dev`、无 catalog
且启用 compile-time dev gate。Electron/Chromium vendor DLL 继续走现有 Electron Builder
policy，并进入独立 normalized hash/signer inventory；本设计不静默启用 `signDlls`。
Authenticode `Status=Valid` 不等于 SmartScreen reputation 或 WDAC/App Control 放行。

### Bundled Full evidence 与 handoff contract

Slice 8 已将 live contract 原子迁移到 candidate manifest v4、release policy v3、
review/build attestation v2、release verification v2、internal verification v1 和 immutable
cell/matrix schemas。TryCua release tuple 只保留 source provenance；运行时信任绑定最终
private main PE、provider seal、signed catalog、Setup/app/uninstaller 和实际观察到的
Authenticode signer。standard 包不得包含 `cua-driver-uia.exe` 或任何额外 provider
executable。

受保护的 release workflow 分两步生成交接包。第一步从干净 candidate commit、批准的
policy、签名前 provider、最终 artifacts、实际签名 observation 和 vendor native inventory
生成不可覆盖的 candidate v4：

```powershell
node apps/desktop/tests/produce-windows-acceptance-handoff.mjs `
  --candidate-source <candidate-production-input.json> `
  --release-policy <windows-release-policy-v3.json> `
  --repository-root <clean-candidate-repository> `
  --git-executable <absolute-trusted-git.exe> `
  --candidate-output <windows-candidate-manifest-v4.json>
```

`candidate-production-input.json` 使用 `schemaVersion=1`、
`kind="ling.windows.candidate-production-input"`，并包含：

- `preSignProvider.path` 与 `auditOnlyUiAccess.path`；
- `daemonPayload.strategy/treeSha256`；
- `artifacts` 的 `lingApp`、`lingInstaller`、`lingUninstaller`、`provider`、
  `providerSeal`、`providerCatalog`。除 seal 外，每项包含 source-relative `path`、最终包内
  `relativePath` 和实际观察到的 `authenticodeStatus/signerSubject/certificateSha256/
  timestampStatus`；
- 排序后的 `vendorNativeInventory`，每项包含 source-relative `path`、包内
  `relativePath` 和 observed signature。未签 vendor 文件必须显式使用 `NotSigned + null`
  signer，而不是省略。

`requiredEvidenceKinds` 当前是固定的 standard 集合：`accessibility`、`display`、
`install-lifecycle`、`provider-runtime`；未知值、漏项或拼写漂移都失败。producer 把每个
vendor native 文件复制到 handoff 的 candidate app tree 并复算 digest，不能只复制清单。

所有 path 都相对该 JSON 文件解析，禁止绝对路径、`..`、symlink 和非普通文件。producer
复算每个 SHA，并要求 governed signer 与 policy 完全一致；这些 input observations 后续仍
会由 Windows Full runner 对 installed candidate 独立复验。

Windows evidence documents 必须绑定该 candidate 文件的实际 SHA-256。收齐 policy 的每个
cell 后，第二步复算 candidate、拒绝 artifact drift，复制 exact candidate/policy/artifacts/
attachments、克隆 exact clean commit，并原子发布新的 handoff root：

`windows-acceptance-evidence-map.json` 使用 `schemaVersion=1`、
`kind="ling.windows.acceptance-evidence-map"`，`cells` 必须与 policy 顺序及集合完全一致。
每个 cell 的 `manualEvidence` 精确列出 `windowsVersion/display/narrator/nvda/
smartScreen/installLifecycle` 的 map-relative JSON 路径；internal profile 的 SmartScreen
固定为 `null`，production profile 必须提供。producer 同时复制并重哈希每份 evidence 的
report-relative attachments，禁止文件或 digest 跨 kind/cell 复用。

```powershell
node apps/desktop/tests/produce-windows-acceptance-handoff.mjs `
  --candidate-source <candidate-production-input.json> `
  --release-policy <windows-release-policy-v3.json> `
  --repository-root <clean-candidate-repository> `
  --git-executable <absolute-trusted-git.exe> `
  --candidate-manifest <windows-candidate-manifest-v4.json> `
  --evidence-map <windows-acceptance-evidence-map.json> `
  --output-root <new-handoff-root>
```

handoff 发布先用不可替换的 `mkdir` 原子 claim 最终 root，逐项移动内容，并最后移动
`handoff-index.json` 作为 ready boundary。并发创建的空目录或崩溃残留不会被覆盖；重跑必须
选择新路径。

producer 固定最低 Node 22.0.0、PowerShell 7.4.0 和 Git 2.45.0；Full runner 在执行任何
candidate 操作前验证这些版本。输出 root、candidate、cell report、matrix 和 verification
均使用 exclusive-create，重跑必须使用新路径和新 `runId`。Windows 同事每个 cell 只运行：

```powershell
& <handoff-root>/repository/apps/desktop/tests/run-windows-acceptance.ps1 `
  -HandoffManifest <handoff-root>/cells/<cell-id>.json
```

runner 安装 Setup 后只从 Ling 私有 resource path 读取 provider/lock/seal/catalog，拒绝 PATH、
旧 CuaDriver 安装、UIAccess helper、任何额外 distribution/platform/payload member（包括
EXE、DLL、数据文件、目录、symlink）、
错误 signer/hash 和不可信 uninstaller；
installed verifier 解析 source lock/seal tuple，并通过可信 Windows `Test-FileCatalog` 与
Authenticode 验证当前 payload 精确成员，并要求 candidate pre-sign SHA 与 source lock 主
二进制 SHA 相同。packaged Desktop smoke 启动前移除 legacy provider command override，
随后通过 daemon `enable` 链初始化 Desktop 发布的 generation lease；daemon 必须返回
`bundled_embedded + ready`、seal/catalog digest 与非空工具表，同时 Desktop 主进程必须观察
runtime-eligible package authority、Win32 platform owner、ready child，并断言 child 的绝对
路径就是安装目录内的 `resources/providers/.../payload/ling-cua-driver.exe`。activation 后，
Desktop 使用 bridge token 请求 daemon 的 provider-target verification；daemon 必须经当前
generation client 调 bundled child 的 `list_windows`，并精确匹配 test-owned PID/HWND。
结构化 runtime proof 必须与 activation 的 Desktop instance/epoch、generation、seal/catalog
digest 一致，同时绑定 child PID、child nonce digest、绝对路径和 target。该证明在 Desktop
重启后重复一次；runner 必须先观察旧 child PID 退出，再要求新的 Desktop instance 与 child
PID/nonce。新 Desktop 的数值 generation 可以重新从 `1` 开始，轮换判据是完整 authority
tuple，而不是跨进程单调数字。helper 注入的 descriptor 只用于指定 capture target，不能
替代 bundled resolver、daemon tool exchange、child/readiness 证据。runner 还逐项复验 candidate
记录的 installed vendor native hash/Authenticode observation，且
任何主流程失败后的清理卸载也必须同时匹配 policy signer 和 candidate uninstaller hash。
它在卸载前完成 read-only provider verifier 与 smoke，并在清理后写出仍固定
`MANUAL_REVIEW_REQUIRED + releaseReady=false` 的 immutable report。

所有 cell 完成后，由受保护 workflow 将 index/candidate/policy digest 和 candidate commit
作为外部锚传给 `finalize-windows-signed-acceptance.mjs`。finalizer 要求 policy cell 恰好各一
份，重新哈希每个 manifest/report/attachment，拒绝 missing/extra/duplicate/cross-cell、
symlink/reparse escape 和 tuple/harness drift。matrix 仍不能 self-promote。最后由两个
policy-pinned、角色互斥的 detached signatures 驱动 profile-aware verifier：

- `verify-windows-internal-attestations.mjs` 只接受
  `test_signed_internal + internal`，最高输出 `INTERNAL_TEST_PASS`，固定
  `releaseReady=false` 与 `production_signing_required`；
- `verify-windows-release-attestations.mjs` 只接受
  `production_signed + production`，完成生产门禁后才可输出 `RELEASE_PASS` 和
  `releaseReady=true`。

仅检测到读屏程序已安装、当前存在两个 display 或 Authenticode `Status=Valid` 都不足以
关闭门禁。当前 macOS 开发机没有 `pwsh`，所以 PowerShell runner 仅通过 Node 静态契约；
PowerShell parser/runtime、真实 test-signed Setup 和 Windows VM matrix 仍由 hosted/managed
Windows lane 与 Windows 同事验收。首个 installer 固定为当前用户安装；all-users 包仍是
独立 artifact/验收通道。

## Clean-machine 顺序

### macOS bundled embedded target

1. 校验 Ling artifact checksum、架构、bundle/app identity、source/patch/toolchain lock、
   post-sign provider seal、exact entitlements 和 outer code-resource seal。
2. 将 Ling 安装到 `/Applications`；不得从 mounted DMG 完成首次 TCC 授权。
3. 不单独安装 Cua Driver；确认 packaged `0.8.3 (Ling build 1)` 由 Electron main 直接
   embedded spawn，daemon 在同一 lease generation 内只建立一个长期 MCP client。
4. 用 `health_report({"skip":["bundle_identity"]})` 和
   `check_permissions({"prompt":false})` 验证协议、核心 health、host attribution 和 live
   capturability；System Settings 只出现 Ling。
5. 写入 bundled config 并重启，确认 versioned `CUA_DRIVER_STATE_HOME` 生效且已有 external
   `~/.cua-driver` 字节不变。
6. 运行 real source smoke：首帧、Hide/Show、Close-without-Stop、Stop ACK、source ended。
7. 在每个声明的 macOS 13/14/15/26 与架构 cell 验证 AX、capture、AppKit 和
   Chromium/Electron background input、cursor、SkyLight failure behavior 和 cleanup。
8. 重启 Desktop，验证 lease generation、provider restart、projection replay 和用户隐藏状态。
9. 升级/回滚整个 Ling artifact，验证 provider 与隔离状态目录随版本切换且 TCC 恢复行为明确。
10. 卸载 Ling，记录 provider/proxy orphan process、cache 和 user-data 保留策略。

### Windows bundled standard-tier internal candidate

1. 校验 Ling artifact checksum、x64 架构、app/NSIS identity、
   `test_signed_internal + internal` policy 和所有实际签名；确认测试信任由外部 harness
   预置且未包含在 Setup。
2. 安装 Ling；不得单独安装 Cua Driver，确认 packaged `0.8.3 (Ling build 1)` 的
   main-provider post-sign seal 与 signed resource catalog 有效，standard 包内不存在
   `cua-driver-uia.exe`。Candidate manifest 只做 release provenance。
3. 启用后确认 Electron main 在同一非零 interactive session 直接 spawn
   `cua-driver.exe mcp --embedded --host-bundle-id com.lingstack.desktop`。Rust child
   建立不可继承的 `KILL_ON_JOB_CLOSE` Job Object；Desktop 仅通过持有的 child handle
   终止主进程，生产路径不得按数字 PID 调 `taskkill /T`。
4. Activation 通过当前 MCP child 的 `ling/managed_readiness` 验证 PID/内存 nonce、
   host/provider Medium integrity、session/input-desktop、Job Object、UIA-runtime 和
   D3D/WGC API；Windows acceptance 再对 test-owned target 独立验证 UIA、ordinary
   input 和真实 WGC frame。不得用 one-shot diagnostics 或 upstream 固定 PASS 的
   `session_active` 把 runtime 标记为 ready。
5. 验证 ready -> lock/disconnect -> lease/tools revoke ->
   `interactive_session_required` -> unlock -> fresh child/generation -> ready；旧 child、
   lease、readiness 和 late notification 必须全部失效，PiP 不因 provider recovery 自动重开。
6. 确认 per-user/asInvoker candidate 投影 `standard` integrity coverage；elevated/UWP
   pixel/SendInput 返回 `cua_windows_uiaccess_required`，不得启动 LocalAppData helper
   冒充 UIAccess。
7. 运行 real source、Desktop/daemon restart、DPI/双屏、Narrator/NVDA、
   Ling/provider tuple upgrade/rollback、uninstall 和零 process/pipe/state residue。
8. Windows 同事生成并签字 internal evidence；profile-aware verifier 最多输出
   `INTERNAL_TEST_PASS` / `releaseReady=false`。本地/非 Windows CI 不能自签该结论。
9. 对 `ephemeral-ci` 删除测试信任或回滚 VM；对 `managed-internal` 记录专用 QA image/VM
   和外部 PKI lifecycle。两者都必须证明 Setup/安装目录不含根证书或 PFX。

### Windows production candidate

1. 从已批准的干净 pre-sign payload 重新构建 `production_signed + production` tuple；不得
   复用 test-signed final bytes、candidate manifest 或 SmartScreen/WDAC evidence。
2. 验证 app、uninstaller、NSIS、provider 和 catalog 的正式 Publisher、certificate
   SHA-256、Code Signing EKU、RFC 3161 timestamp 和 tier/channel 一致性。
3. 重跑所有与最终字节、安装路径、支持 build/DPI/display、Narrator/NVDA、生命周期绑定的
   release cells。
4. SmartScreen 证据绑定 exact candidate、时间、VM、MOTW、网络和策略。若声称 WDAC/App
   Control 兼容，证据绑定 exact policy id/version/hash/enforcement mode。
5. 独立 reviewer/build-attestor verifier 通过后才可输出 `RELEASE_PASS` 和
   `releaseReady=true`。

## Production release 关闭条件

下列任一项缺失时，公开发布状态只能是 `release-blocked`。这些条件不阻止 Windows
test-signed bundled implementation 获得 `INTERNAL_TEST_PASS`：

- Windows x64 interactive VM real-source evidence；
- macOS signed TCC/capture-indicator evidence；
- macOS 13/14/15/26 每个声明架构 cell 的 signed installed-app provider/SkyLight evidence；
- Developer ID/notarization/Gatekeeper 和严格 macOS 签名验证；
- locked source patch/toolchain、post-sign provider seal、exact entitlements 和 state-isolation evidence；
- production Authenticode/RFC 3161/SmartScreen/signed NSIS，以及任何声明的 exact WDAC
  policy evidence；
- clean-machine install/update/uninstall evidence；
- signed/packaged real MediaStream performance report that meets the release budgets；
- CI workflow 的 hosted run 和 artifact 留存；
- VoiceOver、Narrator 和 NVDA 真实平台验收；
- macOS reviewer、Windows reviewer/build attestor 的外部 detached signature 验证；
- clean candidate commit 确定性重建并签名的 daemon tree fingerprint，或 signed candidate
  内嵌 daemon 的等价 provenance 证据。

当前这些外部门禁仍全部开放：Apple Developer ID/notarization/Gatekeeper、locked
source-patch/toolchain 与 post-sign provider seal、clean-host TCC
denied/prompt/granted/revoked、macOS 13/14/15/26 声明 cell 与系统 capture indicator、
Windows x64 interactive VM/provider/DPI/双屏、production Authenticode/SmartScreen/signed NSIS、
hosted signed CI execution、clean-machine install/update/uninstall、
VoiceOver/Narrator/NVDA、外部 detached signatures，以及真实 candidate daemon provenance。
