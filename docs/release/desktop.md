# Ling Desktop 发布验收手册

本文是 Desktop Computer Use PiP 的发布门禁唯一操作清单。它把“本地工程基线”和
“真实平台发布证据”分开，避免把 fake source、unsigned 包或 provider 下载校验误报为
跨平台完成。

Windows provider、签名、安装范围和回滚决策见
[Desktop Windows 发布决策记录](./desktop-windows-release-decisions.md)。

## 支持矩阵

| 平台 | 目标 | 当前证据边界 |
| --- | --- | --- |
| macOS | arm64、x86_64 | unsigned `.app` 与 mounted DMG 的 fake/window/display provenance matrix、当前机器 Cua native handoff 和 real MediaStream 性能已有；Developer ID、TCC 矩阵和 clean machine 未闭合 |
| Windows | x86_64 | branded unsigned x64 app/per-user NSIS cross-package、exact Cua Driver v0.8.3 verifier/allowlist，以及 health、双目标 revision、Desktop restart runner 已有；provider 仍是 unsigned prerelease，Windows 安装执行和 interactive VM real capture 未闭合 |
| Linux | 不支持 | provider gate 必须 fail closed |

Ling 只发布 Cua Driver plugin shell metadata，不打包 provider 二进制、原生库、凭据或
权限状态。Windows provider 当前固定审阅基线为：

```text
trycua/cua  cua-driver-rs-v0.8.3
SHA-256      6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0
```

该上游 release 当前为 `prerelease=true`，审阅的两个 Windows provider executable 均无
PE certificate table。它只能进入内部/beta 验收，公开发布风险和签名责任必须按 Windows
发布决策记录显式关闭。

## 每次提交的本地基线

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
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
和 actionlint 也全部通过。`docs/release/evidence/**` 已进入 Desktop artifact workflow 的
pull request 和 `main` push 路径过滤，因此只改 schema 也会触发该门禁。

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
hdiutil verify 'apps/desktop/release/Ling Stack-0.0.0-arm64.dmg'
hdiutil verify 'apps/desktop/release/Ling Stack-0.0.0.dmg'
unzip -t 'apps/desktop/release/Ling Stack-0.0.0-arm64-mac.zip'
unzip -t 'apps/desktop/release/Ling Stack-0.0.0-mac.zip'
```

unsigned job 必须验证：

- `CFBundleIdentifier=com.lingstack.desktop`；
- `CFBundleIconFile=icon.icns`，且 arm64/x64 bundle 内图标与提交的 Ling icon 字节一致；
- arm64/x86_64 Mach-O 架构正确；
- bundled Cua Driver 只有 manifest、MCP metadata、README；
- 不存在 Developer ID Authority 或 Team ID；
- fake、real-window、primary-display packaged provenance smoke 在 arm64 和 x86_64
  两个 `.app` 以及挂载后的两个 DMG 中都通过；
- Cua native-window handoff 在 dev Electron 和 arm64/x86_64 packaged `.app` 中通过：
  Electron source ID 只作为测试 oracle，交给 Ling descriptor 的只有 Cua provider
  PID 和 `nativeWindowId`，不得按标题、前台窗口或 z-order 选择。

这类包只能作为工程候选包，不能作为 Gatekeeper 或 TCC 发布证据。

### `e20777f5` baseline unsigned 产物（非当前候选）

| 产物 | SHA-256 |
| --- | --- |
| `Ling Stack-0.0.0-arm64.dmg` | `e42b944b84bf67174d18dec422637cbde6988c4d2283f503597b09aae50727fb` |
| `Ling Stack-0.0.0.dmg` | `a9e8aa208af6dc9baff96b9550166095660adc1b596c4f86544287ac0ca19258` |
| `Ling Stack-0.0.0-arm64-mac.zip` | `6c9ac51d212a7a4b930cf8bcb8c93f7e4b4f07bb17b93d1205f01b2ff99face5` |
| `Ling Stack-0.0.0-mac.zip` | `49a8bc3d5dce9def59c49b7a53f9fb31fea72e960dd9e99f806809d995bb695e` |
| `win-unpacked/Ling Stack.exe` | `3f6ad1bbb45816bb46b15d2e23eb7a60843eb2a8fbc25ae0e541fb29af1d596e` |
| `Ling Stack Setup 0.0.0.exe` | `52b115f2ef02394ed0e352c28f60052ec572eec02f708c2a942bd64d9b4de5e2` |

两个 DMG 均通过 `hdiutil verify`，两个 ZIP 均通过 `unzip -t`。Vite preview build
现会先清空 `outDir`；最终 `app.asar` 的 preview subtree 只有本次构建的 **7 个条目**
（2 个目录和 5 个文件），不存在上一轮 hash asset 残留。Windows unpacked application 是 PE32+ x86_64；
NSIS 使用常规 PE32 x86 bootstrap stub 承载该 x64 application。两者的 PE
certificate-table size 均为 **0**，因此没有嵌入 Authenticode 签名。当前机器也没有
Apple Developer ID identity；上述哈希和完整性检查都不能写成签名或 notarization
结论。

工程候选已替换默认 Electron 图标：两个 macOS bundle 的 `icon.icns` 与提交资源完全
一致；Windows app 和 NSIS 的 9 个 icon frame 与 `icon.ico` 一致。Windows NSIS 明确为
one-click、per-user、`asInvoker`，`packElevateHelper=false`；当前 unpacked 和 installer
payload 都不存在 `elevate.exe`。

## macOS signed release

只有拿到 Developer ID identity、Team ID 和 notarization 凭据后才能运行：

```bash
codesign --verify --deep --strict 'apps/desktop/release/mac-arm64/Ling Stack.app'
codesign --verify --deep --strict 'apps/desktop/release/mac/Ling Stack.app'
spctl -a -vv 'apps/desktop/release/mac-arm64/Ling Stack.app'
spctl -a -vv 'apps/desktop/release/mac/Ling Stack.app'
xcrun notarytool submit <artifact> --wait
xcrun stapler validate 'apps/desktop/release/mac-arm64/Ling Stack.app'

node apps/desktop/tests/verify-macos-signed-candidate.mjs \
  --team-id <TEAM_ID> \
  --bundle-id com.lingstack.desktop \
  --app 'apps/desktop/release/mac-arm64/Ling Stack.app' \
  --app 'apps/desktop/release/mac/Ling Stack.app' \
  --dmg 'apps/desktop/release/Ling Stack-<version>-arm64.dmg' \
  --dmg 'apps/desktop/release/Ling Stack-<version>.dmg' \
  --zip 'apps/desktop/release/Ling Stack-<version>-arm64-mac.zip' \
  --zip 'apps/desktop/release/Ling Stack-<version>-mac.zip' \
  --output apps/desktop/test-results/macos-signed-candidate.json
```

verifier 会逐 Mach-O 检查 Developer ID、Team ID 和 hardened runtime，并只读挂载/解包
DMG、ZIP，重新验证其中唯一 Ling app，再把 arm64/x86_64 的 main executable、bundle
tree fingerprint 和 CDHash 绑定到 standalone app。缺任一架构、DMG、ZIP，或归档内 app 不一致时不得产生
`signedCandidateEvidence=true`。报告中的 artifact path 一律相对 candidate report 所在
目录；复制到 clean host 时必须保留 report 与 `release/` 树的相对布局，不能依赖 signing
host 的绝对路径。

签名矩阵必须在 clean machine 覆盖：Screen Recording denied、prompt、granted、revoked，
窗口捕获、display 捕获、source ended、descriptor revision、Desktop restart、track
释放和系统 capture indicator。测试不得修改用户原有 TCC 状态。

每个 TCC case 使用 `run-macos-tcc-acceptance.mjs` 生成独立 JSON。arm64、x86_64 各自
必须生成 denied/prompt/granted/revoked 四份，共八份；finalizer 校验 host architecture、
实际执行架构和 candidate executable SHA，universal binary 不能在单一 host 上替另一架构
关门。脚本会在目标 host
重新执行完整 signed-candidate verifier，而不是信任可编辑报告中的 PASS。`granted`
必须带 window/display capture-indicator 证据、运行两个真实 smoke，并以同一个 signed
executable 连续完成两次 Desktop launch/recovered projection。`revoked` 先运行：

```bash
node apps/desktop/tests/run-macos-tcc-revocation.mjs \
  --executable '<Ling Stack executable>' \
  --signed-candidate-report '<candidate.json>' \
  --operator '<name>' \
  --capture-indicator-evidence '<revocation recording>' \
  --output '<revocation-arm64-or-x86_64.json>'
```

runner 启动 signed display capture 并输出 READY；操作员在 System Settings 撤权并等待
系统 capture indicator 清除后按 Enter。Desktop 随后机器观察 source ended/permission
failure、runtime 未 Stop 和 `stopRequestCount=0`，退出后再 probe denied/restricted。
TCC revoked case 必须消费
符合 [revocation schema](./evidence/macos-tcc-revocation.schema.json) 的两阶段证据，证明
活跃捕获后人工撤权、source ended/permission failure、runtime 未被 Stop，以及系统
indicator 清除。脚本不得调用 `tccutil`；任何 setup/probe/smoke 异常仍须原子写出
`verdict=FAIL` 报告。

每个架构还必须生成 packaged signed performance：

```bash
node apps/desktop/tests/run-macos-signed-performance.mjs \
  --executable '<Ling Stack executable>' \
  --signed-candidate-report '<candidate.json>' \
  --output '<signed-performance-arm64-or-x86_64.json>'
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

finalizer 会重新运行完整 candidate verifier，读取并重算所有 nested SHA-256，验证八份
TCC 的 permission semantics、host/execution architecture、smoke/restart/revocation logs，
并把 capture-indicator refs 绑定到各架构 granted case。每个 DMG/ZIP 都必须有
`notarytool` `Accepted` JSON log，其 job id 与 artifact SHA 绑定；signed performance 也须
在两个架构上分别绑定 candidate executable、producer 和 raw cycle logs。最终报告结构见
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

Windows `Full` 必须通过 `run-windows-acceptance.ps1 -Mode Full`，并额外提供：

- 经负责人批准的 release policy，包含固定 policy version、approver、approval time、Ling
  Publisher subject、provider upstream signer subject、双方签名证书 SHA-256 和支持的
  Windows build allowlist，以及 reviewer/build-attestor identity、key id、算法和 canonical
  SPKI SHA-256 指纹；两类角色的 identity、key id 和 SPKI 必须跨角色互斥，结构见
  [Windows release policy schema](./evidence/windows-release-policy.schema.json)；
- 与当前 commit、policy hash、Ling app/installer、固定 upstream archive tuple，以及
  `cua-driver.exe`、`cua-driver-uia.exe` 两个固定 hash 一致的 content-addressed candidate
  manifest；manifest v3 还必须记录 clean candidate commit 对应的 daemon payload strategy
  和 tree SHA-256，结构见
  [Windows candidate manifest schema](./evidence/windows-candidate-manifest.schema.json)；
- 六份符合
  [Windows Full manual evidence schema](./evidence/windows-full-manual-evidence.schema.json)
  的独立 JSON：supported build、跨双屏/两档 DPI、Narrator、NVDA、SmartScreen，以及
  clean baseline/install/installed smoke/update/uninstall/零残留。每份 evidence 都必须
  绑定 candidate manifest SHA、当前 host/session/build、case outcome、与 operator 不同的
  reviewer routing claim，以及 report-relative retained attachment hash，禁止跨 kind 复用
  同一 evidence 文件。该 reviewer JSON 只是未验证的路由元数据，不能关闭发布门禁。

Full runner 在执行 NSIS 前先校验 installer 和 standalone app 的 Authenticode status、
Publisher subject 与 certificate SHA；安装后再次校验 installed app/uninstaller，并要求
installed app hash 等于 candidate manifest。签名不可信的 uninstaller 即使处于失败清理
路径也不得执行。runner 同时记录自身及 provider/report scripts 的 SHA，并由异步 verifier
按 candidate commit 的 Git blob 重新验证；report 自带路径或 Git 可执行文件不能成为信任锚。
Full 调用方还必须从 release orchestrator 独立传入 expected candidate commit、expected clean
repository root 和 expected release-policy SHA-256。Node file validator 会把三项外部锚分别与
report binding、harness commit/root、已重算 hash 的 policy reference 交叉比对；Preflight
不要求这三项外部参数，但仍然不能产生 Full PASS。这三个 caller-fixed 外部信任锚的本地
实现和定向测试已完成；它们防止 report 自己指定信任根，但不构成 Windows VM 发布证据。
三锚也不验证 manual evidence JSON 内自报的 reviewer 身份；仅命中 policy reviewer
allowlist 不能作为信任证明。Windows Full 必须在独立信任边界验证 detached reviewer
attestation，缺失或不匹配时 fail closed。报告生成器即使得到
`fullAcceptanceStatus=PASS`，仍固定输出 `releaseReady=false` 和两个 blocker：
`external_reviewer_attestation_unverified`、`candidate_build_provenance_unverified`。
此时 `releaseStatus=MANUAL_REVIEW_REQUIRED`，不能把 Full gates PASS 当成发布 PASS。
第二个 blocker 只有 policy-pinned build attestor 对 candidate manifest v3 中的 commit、
daemon strategy/tree SHA 和 artifact tuple 进行 detached signature 后才能关闭；这覆盖从
clean candidate commit 确定性重建 ignored `packages/daemon/dist`，或只运行 signed
candidate 内嵌 daemon 的两种策略。

```powershell
& apps/desktop/tests/run-windows-acceptance.ps1 `
  -Mode Full `
  -Output apps/desktop/test-results/windows-full-acceptance.json `
  -LingAppPath <signed-unpacked-exe> `
  -LingInstallerPath <signed-nsis-exe> `
  -ProviderBinary <pinned-cua-driver.exe> `
  -ReleasePolicy <approved-windows-release-policy.json> `
  -CandidateManifest <windows-candidate-manifest-v3.json> `
  -ExpectedCandidateCommit <candidate-commit> `
  -ExpectedRepositoryRoot <absolute-clean-repository-root> `
  -ExpectedReleasePolicySha256 <approved-policy-sha256> `
  -WindowsVersionEvidence <windows-version.json> `
  -DisplayEvidence <dual-display-dpi.json> `
  -NarratorEvidence <narrator.json> `
  -NvdaEvidence <nvda.json> `
  -SmartScreenEvidence <smartscreen.json> `
  -InstallLifecycleEvidence <install-lifecycle.json>
```

该 Full producer 在 gates PASS 时仍以 code 2 返回，表示证据包已生成但发布人工复核/构建
证明尚未完成；只有下面的独立 verifier 成功后才有 release PASS。

两个 detached signature 必须由独立 verifier 复算 canonical evidence digest、SPKI 指纹和
签名，并拒绝 reviewer/build 角色复用 identity、key id 或同一真实 RSA key，之后才生成
单独的 release verification；builder/PowerShell runner 本身没有
`releaseReady=true` 路径：

```powershell
node apps/desktop/tests/verify-windows-release-attestations.mjs `
  --report apps/desktop/test-results/windows-full-acceptance.json `
  --review-attestation <detached-review.json> `
  --reviewer-public-key <reviewer-public-key.pem> `
  --candidate-build-attestation <detached-build.json> `
  --candidate-build-public-key <build-attestor-public-key.pem> `
  --git-executable <trusted-git.exe> `
  --expected-candidate-commit <candidate-commit> `
  --expected-repository-root <absolute-clean-repository-root> `
  --expected-release-policy-sha256 <approved-policy-sha256> `
  --output apps/desktop/test-results/windows-release-verification.json
```

仅检测到读屏程序已安装、当前存在两个 display、或 Authenticode `Status=Valid` 不足以
关闭门禁。Full runner 还会拒绝非 x64 host、未批准 policy、未知 Publisher、未签名
provider helper、非固定 upstream archive/binary hash、exitCode/error 与 `passed=true`
冲突的 probe，以及没有显式绝对路径的 provider。Preflight 同样不再从 PATH
发现 provider；只有调用者显式提供并通过两个固定 binary SHA 校验后，verifier 才会
执行 `--version`。provider verifier 的 PowerShell、解压和超时清理工具使用系统绝对路径；
PowerShell runner 对 Node/Git/provider smoke 均有有限时长和进程树清理，超时不会遗留旧的
PASS 报告。当前 macOS 主机没有 `pwsh`，也没有 Windows PowerShell；上述 PowerShell
runner 只经过 Node 静态契约验证，PowerShell parser/runtime 和真实 Windows 执行尚未验证。

首个 installer 固定为当前用户安装。企业级 all-users/per-machine 包若需要，应作为
独立 artifact 和验收通道，不能在当前候选中临时切换安装范围。

## Clean-machine 顺序

1. 校验 Ling artifact checksum、架构、bundle/app identity 和签名。
2. 安装 Ling；确认 daemon 只绑定自己的 loopback/workspace。
3. 单独安装 pinned Cua Driver provider，记录 provider 版本和 Authenticode 状态。
4. 运行 `health_report`，确认 interactive session、UIA、DXGI/screen capture 均通过。
5. 运行 real source smoke：首帧、Hide/Show、Close-without-Stop、Stop ACK、source ended。
6. 重启 Desktop，验证 projection/descriptor replay 和用户隐藏状态。
7. 升级到下一 provider/Ling 版本，重复 health 和 source lifecycle。
8. 卸载 Ling 和 provider，记录 orphan process、cache、user-data 保留策略。

## 关闭条件

下列任一项缺失时，发布状态只能是 `release-blocked`：

- Windows x64 interactive VM real-source evidence；
- macOS signed TCC/capture-indicator evidence；
- Developer ID/notarization/Gatekeeper 和严格 macOS 签名验证；
- Authenticode/SmartScreen/signed NSIS；
- clean-machine install/update/uninstall evidence；
- signed/packaged real MediaStream performance report that meets the release budgets；
- CI workflow 的 hosted run 和 artifact 留存；
- VoiceOver、Narrator 和 NVDA 真实平台验收；
- macOS reviewer、Windows reviewer/build attestor 的外部 detached signature 验证；
- clean candidate commit 确定性重建并签名的 daemon tree fingerprint，或 signed candidate
  内嵌 daemon 的等价 provenance 证据。

当前这些外部门禁仍全部开放：Apple Developer ID/notarization/Gatekeeper、clean-host
TCC denied/prompt/granted/revoked 与系统 capture indicator、Windows x64 interactive
VM/provider/DPI/双屏、Authenticode/SmartScreen/signed NSIS、hosted signed CI execution、clean-machine
install/update/uninstall、VoiceOver/Narrator/NVDA、外部 detached signatures，以及真实
candidate daemon provenance。
