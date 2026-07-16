# Ling Desktop 发布验收手册

本文是 Desktop Computer Use PiP 的发布门禁唯一操作清单。它把“本地工程基线”和
“真实平台发布证据”分开，避免把 fake source、unsigned 包或 provider 下载校验误报为
跨平台完成。

## 支持矩阵

| 平台 | 目标 | 当前证据边界 |
| --- | --- | --- |
| macOS | arm64、x86_64 | unsigned `.app` 与 mounted DMG 的 fake/window/display provenance matrix、当前机器 Cua native handoff 和 real MediaStream 性能已有；Developer ID、TCC 矩阵和 clean machine 未闭合 |
| Windows | x86_64 | unsigned x64 app/NSIS cross-package、Cua Driver v0.8.3 verifier，以及 health、双目标 revision、Desktop restart runner 已有；Windows 安装执行和 interactive VM real capture 未闭合 |
| Linux | 不支持 | provider gate 必须 fail closed |

Ling 只发布 Cua Driver plugin shell metadata，不打包 provider 二进制、原生库、凭据或
权限状态。Windows provider 当前固定审阅基线为：

```text
trycua/cua  cua-driver-rs-v0.8.3
SHA-256      6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0
```

## 每次提交的本地基线

```bash
corepack pnpm --filter @ling-stack/desktop typecheck
corepack pnpm --filter @ling-stack/desktop build
node --test apps/desktop/tests/*.test.mjs
node --test \
  packages/contracts/test/computer-use.test.mjs \
  packages/api-client/test/computer-use.test.mjs \
  packages/daemon/test/computer-use-api.test.mjs \
  packages/daemon/test/computer-use-producer.test.mjs \
  packages/daemon/test/computer-use-registry-retention.test.mjs \
  packages/daemon/test/computer-use-run-integration.test.mjs \
  packages/daemon/test/cua-driver-preset.test.mjs \
  packages/daemon/test/provider-health.test.mjs \
  packages/daemon/test/plugin-manager-api.test.mjs
corepack pnpm --filter @ling-stack/desktop exec playwright test --config tests/playwright.renderer.config.mjs
corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/app-shell-selectors.spec.ts e2e/desktop-computer-use-bridge.spec.ts
node apps/desktop/tests/run-computer-use-smoke.mjs
node --expose-gc apps/desktop/tests/computer-use-performance-harness.mjs
node apps/desktop/tests/run-computer-use-smoke.mjs --real
node apps/desktop/tests/run-computer-use-smoke.mjs --display
corepack pnpm --filter @ling-stack/desktop performance:computer-use:real
corepack pnpm --filter @ling-stack/desktop exec electron tests/screenshot-app
git diff --check
```

2026-07-16 最终本地验证矩阵为：Desktop Node **169/169**、PiP renderer **17/17**、
focused contracts/API/daemon/plugin **51/51**、focused Web **16/16**、macOS screenshot
baseline **10/10**。本地 lifecycle、四角 snap、aspect ratio 和 Stop 交互/ack 时序缺口
均已闭合。

一次 full daemon parallel suite 运行中，`channel auto_route` 单测出现并行调度波动并
遗留 worker；该测试独立复跑通过，focused Desktop PiP daemon/plugin 矩阵仍为
**51/51**。这项记录属于并行测试基础设施稳定性，不是 Desktop PiP 产品失败。

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
- arm64/x86_64 Mach-O 架构正确；
- bundled Cua Driver 只有 manifest、MCP metadata、README；
- 不存在 Developer ID Authority 或 Team ID；
- fake、real-window、primary-display packaged provenance smoke 在 arm64 和 x86_64
  两个 `.app` 以及挂载后的两个 DMG 中都通过；
- Cua native-window handoff 在 dev Electron 和 arm64/x86_64 packaged `.app` 中通过：
  Electron source ID 只作为测试 oracle，交给 Ling descriptor 的只有 Cua provider
  PID 和 `nativeWindowId`，不得按标题、前台窗口或 z-order 选择。

这类包只能作为工程候选包，不能作为 Gatekeeper 或 TCC 发布证据。

### 2026-07-16 最终 unsigned 产物

| 产物 | SHA-256 |
| --- | --- |
| `Ling Stack-0.0.0-arm64.dmg` | `efeacc2dc49386364fd72808437454afe31ad7de382e20d70ee6bec2be4fa3ef` |
| `Ling Stack-0.0.0.dmg` | `f48cdb81f0c44b92103d0d01c01dac92a1f90f0af1d2f47b7333d43f8e9ef87a` |
| `Ling Stack-0.0.0-arm64-mac.zip` | `ec652852e7a767c2bc3d4119f1c8225f70986e076bac3d6be0ca7b93d92dd0d2` |
| `Ling Stack-0.0.0-mac.zip` | `4d1052391c0a464a9f9c248bb4b5612982a059a1f0d2f44d375e5dd555bfbe2d` |
| `win-unpacked/Ling Stack.exe` | `23d3161f5e9f617c87eebfdcddcc22cb352ba0b75de1f8f3f40beb44147a4e46` |
| `Ling Stack Setup 0.0.0.exe` | `f0aba26eb6b79e64fdbdb1a6bf9e85197aed1e5906877843e76a19b6cd7e18d8` |

两个 DMG 均通过 `hdiutil verify`，两个 ZIP 均通过 `unzip -t`。Vite preview build
现会先清空 `outDir`；最终 `app.asar` 的 preview subtree 只有本次构建的 **7 个条目**
（2 个目录和 5 个文件），不存在上一轮 hash asset 残留。Windows unpacked application 是 PE32+ x86_64；
NSIS 使用常规 PE32 x86 bootstrap stub 承载该 x64 application。两者的 PE
certificate-table size 均为 **0**，因此没有嵌入 Authenticode 签名。当前机器也没有
Apple Developer ID identity；上述哈希和完整性检查都不能写成签名或 notarization
结论。

## macOS signed release

只有拿到 Developer ID identity、Team ID 和 notarization 凭据后才能运行：

```bash
codesign --verify --deep --strict 'apps/desktop/release/mac-arm64/Ling Stack.app'
codesign --verify --deep --strict 'apps/desktop/release/mac/Ling Stack.app'
spctl -a -vv 'apps/desktop/release/mac-arm64/Ling Stack.app'
spctl -a -vv 'apps/desktop/release/mac/Ling Stack.app'
xcrun notarytool submit <artifact> --wait
xcrun stapler validate 'apps/desktop/release/mac-arm64/Ling Stack.app'
```

签名矩阵必须在 clean machine 覆盖：Screen Recording denied、prompt、granted、revoked，
窗口捕获、display 捕获、source ended、descriptor revision、Desktop restart、track
释放和系统 capture indicator。测试不得修改用户原有 TCC 状态。

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
- VoiceOver、Narrator 和 NVDA 真实平台验收。

当前这些外部门禁仍全部开放：Apple Developer ID/notarization/Gatekeeper、clean-host
TCC denied/prompt/granted/revoked 与系统 capture indicator、Windows x64 interactive
VM/provider/DPI/双屏、Authenticode/SmartScreen/signed NSIS、hosted CI、clean-machine
install/update/uninstall，以及 VoiceOver/Narrator/NVDA。
