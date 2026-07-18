# Ling Desktop Windows 发布决策记录

日期：2026-07-17

状态：bundled standard-tier 与三层签名工程策略已冻结；生产 Publisher/发布负责人签字仍待完成
适用范围：Desktop Computer Use PiP 首个 bundled Windows x64 候选

本文是实现计划 T15.5 的决策证据。它区分已经冻结、待按实现计划写入代码的工程
约束和必须由产品、法务或发布负责人确认的发行选择。未确认项不得在 Windows VM
验收期间临时决定。

## 已冻结的工程约束

### Provider source/build lock

- 首个候选只接受 `cua-driver-rs 0.8.3`，不得把 `>=0.8.3` 当成兼容保证。
- 固定上游 tag：`cua-driver-rs-v0.8.3`。
- 固定 Windows x86_64 asset：
  `cua-driver-rs-0.8.3-windows-x86_64.zip`。
- 固定 asset size：`10,585,087 bytes`。
- 固定 SHA-256：
  `6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0`。
- 固定解包后的 `cua-driver.exe` SHA-256：
  `3cc33572defac29e23bc07e211c20245da9f6ebe8e6481f865b31534b1de8cee`。
- 固定解包后的 `cua-driver-uia.exe` SHA-256：
  `1b35a27d41008507d66f819248751b9e79a15c9e6e03390c56749c6fe5daca1c`。
- 上述 zip/PE 只作为上游 `0.8.3` 参考证据，不直接进入 Ling 包。
- 最终 packaged provider 必须从固定 tag commit/tree、`Cargo.lock`、
  `ling-managed-embedded-v1` patch series 和锁定 MSVC/Windows SDK 工具链构建。
- standard 用户包只包含最终 `cua-driver.exe`；它使用 post-sign seal，且 Ling 签名
  catalog 位于 payload 外并覆盖 `payload/cua-driver.exe` 与
  `payload/provider-seal.json`；被覆盖的 seal 再锚定 provider lock digest，避免
  catalog 自引用。不得用参考 asset SHA 或 candidate manifest 代替 installed runtime
  身份。
- `Ling Stack Setup.exe` 是唯一安装器。它把 `cua-driver.exe` 作为 Ling 私有资源释放到
  版本化 `resources/providers/.../payload/` 目录；不注册第二个产品、不写 PATH、不建开始
  菜单项或 Windows 服务，也不提供独立卸载器/更新器。只在 runner 临时目录下载或签名
  provider 不算内置。
- `cua-driver-uia.exe` 仅作为 CI source-build 审计产物记录，Conditional UIAccess
  slice 完成前不得签名、seal 或进入 standard 用户包。
- standard provider 由 Rust embedded entry point 建立不可继承的
  `KILL_ON_JOB_CLOSE` Job Object；Desktop 只通过最初持有的 child handle 终止主进程，
  生产路径禁止按数字 PID 调 `taskkill /T`。
- readiness 必须来自当前 MCP child 的 `ling/managed_readiness`，并绑定 PID、内存 nonce、
  generation、session、Medium integrity 和 Job Object。one-shot diagnostics 仅用于 build/
  preflight/acceptance，不得把 runtime 投影为 ready。
- lock、disconnect、fast-user-switch 或 input desktop 变化必须先 revoke lease/tools，
  unlock 后只能用新 child/generation 重新探测；不得复用旧 readiness。
- `electron-builder@26.15.3` 的 provider 签名顺序必须由 test-certificate spike 证明：
  `afterPack` 完成 PE 签名、seal 和 catalog，自定义 signer 跳过已 seal provider，
  `afterSign` 与最终 NSIS 再校验字节完全一致。任何二次签名或 post-seal mutation 失败。
- release policy 除 `supportedWindowsBuilds` 外还必须列出
  `requiredAcceptanceCells`；每个 build 至少包含 single-display 和 dual-display
  mixed-DPI cell。每个 cell 不可覆盖写，matrix finalizer 必须完整聚合后仍保持
  `MANUAL_REVIEW_REQUIRED`。
- Windows handoff 包含共同 `handoff-index.json` 和逐 cell manifest。每个报告绑定相同
  `handoffIndexSha256` 与独立 `cellManifestSha256`；Windows 同事只用
  `-HandoffManifest` 单入口执行真实 cell。manifest 不是 trust root，index digest 由受
  保护 workflow 或 detached signature 固定。
- daemon provider health 和 Windows VM smoke 都必须拒绝未审阅的更高版本。

Provider 升级只能通过独立 PR。该 PR 必须同时更新 source/build lock、verifier、accepted distribution tuple、VM
smoke、CI 和本文，并重新完成来源/许可证/SHA、schema/tools、真实窗口生命周期、升级
和回滚验收。不得自动跟随 GitHub `latest`。

### 签名等级与结论上限

是否为 `bundled_embedded`、能力等级 `standard`/`uiaccess`、签名等级是三个独立维度。
首版实现目标是 `standard + test_signed_internal`，不是等待生产证书。

| `signingTier` | `distributionChannel` | 用途 | 最高结论 |
| --- | --- | --- | --- |
| `unsigned_dev` | `development` | 本地/签名前工程验证；无可信 catalog | 不得晋级 |
| `test_signed_internal` | `internal` | 自动化 Windows CI、隔离的内部 Windows QA、最终 Setup 功能验收 | `INTERNAL_TEST_PASS`，固定 `releaseReady=false` |
| `production_signed` | `production` | 正式发行候选 | 完整生产门禁后才可 `RELEASE_PASS` / `releaseReady=true` |

`test_signed_internal` 必须使用真实 Authenticode 签 PE、catalog、Ling app、uninstaller 和
NSIS，不能用 JSON 中的 `signed=true` 冒充。测试根和私钥由产品外的 harness 只预置到
一次性 CI VM 或专用隔离 QA 机器。`ephemeral-ci` 每个 job 后删除或回滚；
`managed-internal` 可只在专用隔离 QA image/VM 中由外部 PKI 持续管理，不得随 Setup/PFX
分发、不得由 Ling 导入、不得进入普通开发机、通用 golden image 或生产信任链。

签名等级治理 tuple 固定为 NSIS installer、installed Ling main PE、可信 uninstaller、私有
`cua-driver.exe` 和 signed-tier `provider-integrity.cat`；provider 私有 payload 不允许其他
executable。Electron/Chromium vendor DLL/native resources 继续使用现有 Electron Builder
policy，本设计不静默启用 `signDlls`，candidate 另存 normalized path/hash/observed-signer
inventory；新增 Ling-owned executable 前必须先显式扩展 policy/schema。

candidate 中的 tier/channel 只是待验证事实。独立 verifier 必须从 governed tuple 的实际
签名链和 channel policy 派生最低等级；internal/production tuple 中出现混签、双签、任一
未签 governed member、production test root、provider payload 内意外 executable 或
tier/channel 交叉组合都 fail closed；development tuple 则必须让所有预期 governed PE
派生为 `unsigned_dev`、无 catalog 且仅由 compile-time dev gate 启用。candidate 同时绑定干净
`preSignPayloadSha256` 与各等级 final hashes。生产候选必须从干净签名前 payload 重新生成，
禁止覆盖、追加签名或直接晋级 test-signed PE。

### Provider 发行风险

上游 `cua-driver-rs-v0.8.3` 发布于 2026-07-15，GitHub release 标记为
`prerelease=true`。当前审阅的 `cua-driver.exe` 和 `cua-driver-uia.exe` 都没有 PE
certificate table，不能声称已通过 Authenticode 或 SmartScreen 信任。

因此 `0.8.3` 只允许进入 `internal` channel 验收。Ling 不重签参考资产；bundled
target 的签名 authority 固定为 `ling_approved_repackage`：Ling 从固定 MIT 源码构建
`0.8.3 (Ling build 1)` 并签名自己的最终 PE，同时把 TryCua tag/archive/hash 仅作为上游
来源证明，不能把 Ling 测试或生产证书写成 TryCua signer。公开生产发布仍默认
阻塞，直到稳定上游版本通过同一 source-build/signing/acceptance 矩阵，或负责人对
prerelease source pin 留下显式风险接受记录。

Production bundled standard Full acceptance 要求最终 main PE 和 provider catalog 的
Authenticode 均为 `Valid`，并绑定负责人确认的 Ling signer subject、certificate
SHA-256 和 timestamp policy；还要证明 catalog member 完整且包内没有 UIAccess
helper。单纯接受 prerelease 风险不会把 `releaseReady` 改成 PASS。

内部 test-signed 验收可以关闭 Authenticode 完整性、catalog、Electron Builder hook、
tamper、安装/升级/卸载、MCP 和 Job Object 等真实工程门禁，但不能证明正式 Publisher、
SmartScreen reputation 或生产 WDAC/App Control 兼容性。`Status=Valid` 只说明当前 trust
context 下 Authenticode 有效。SmartScreen 必须绑定 exact candidate、时间、VM、MOTW、
网络和策略，只能记录有界的 `observed_no_warning`，不得写成“SmartScreen 已认证/永久信任”；
若声称 WDAC 兼容，证据必须绑定 policy id/version/hash/enforcement mode。

### Ling 安装范围

首个 Ling Desktop Windows 包固定为：

```text
oneClick = true
perMachine = false
requestedExecutionLevel = asInvoker
packElevateHelper = false
```

它是无管理员权限的 per-user 安装，目标目录位于当前用户的 LocalAppData。首发不提供
同一个 installer 内的 per-user/per-machine 二选一。未来若有企业 all-users 需求，应
建立独立 per-machine artifact、证书策略和 clean-machine 验收通道。

该安装范围只声明 `standard` integrity coverage。上游 `cua-driver-uia.exe` 要获得
UIAccess 必须同时满足 Authenticode、ShellExecute 和 `Program Files` 等 secure path；
当前 LocalAppData 包不满足，运行时不得把 helper presence 当作 ready，也不得要求客户
关闭 `EnableSecureUIAPaths`。standard 包直接排除 helper；只有未来独立 secure-path
artifact 才能加入发布 tuple。

### 证书与第三方边界

- 内部候选使用 policy-pinned 测试证书，信任根由外部 harness 临时配置且不进入产品；该
  证书只能产生 `INTERNAL_TEST_PASS`。
- 生产候选的 app、uninstaller、NSIS、main provider PE 和 provider catalog 必须由 Ling
  法律发布实体批准的组织身份签署。
- 生产路径禁止个人开发者证书、多人共享 PFX 或把可导出的长期私钥直接存入普通 CI
  secret；优先使用 Azure Trusted Signing 或组织控制的云 HSM/EV 签名服务。
- Ling 从固定 MIT 源码构建并签署自己的 provider distribution；参考上游 PE 保持原样，
  只用于来源对照。
- main provider PE、provider catalog、Ling app、uninstaller 和 NSIS 的实际 Authenticode
  身份必须由对应 internal/production policy 固定。

### 回滚单元

发布与回滚单元是不可拆分的：

```text
(Ling Desktop version + exact provider version + provider lock SHA-256
 + signingTier + distributionChannel + observed certificate fingerprints
 + pre-sign payload SHA-256 + main PE seal SHA-256 + catalog SHA-256/null)
```

保留上一套已验收的签名 Ling 安装包和 provider 资产。任一签名、health、PID/HWND
身份、真实捕获、安装或升级门禁失败时停止发布并整体回退到上一 tuple；禁止只热换
provider 后继续沿用旧证据。

test-signed 与 production-signed 的 PE/catalog/app/installer 字节不同，必须拥有不同
candidate manifest、hash 和 SmartScreen/WDAC evidence；不得复用内部候选的发布证据。

## 待负责人确认

1. **公开发行是否接受当前 prerelease source pin。** 推荐不接受，只用于 `internal` channel；
   packaged PE 是否签名是独立硬门禁，不能豁免。
2. **Ling 生产 Publisher 法律名称和签名服务。** 需要在 Azure Trusted Signing 与组织
   控制的云 HSM/EV 方案中选择，并配置 CI 身份与审计责任人。该项只阻塞
   `production_signed` / `RELEASE_PASS`，不阻塞 test-signed 内置实现。
3. **Windows 支持下限。** Electron 43.1.1 只提供“Windows 10 及以上”的框架边界，
   Ling 仍需选择实际产品范围。推荐首发收窄到 Windows 11 x64，并以真实 VM build
   矩阵写明具体版本；若支持 Windows 10 或多个 Windows 11 版本，必须逐项增加验收。
4. **是否要求首发支持 UIAccess-only elevated/UWP pixel input。** 推荐首发不要求，保持
   standard tier；若要求，必须新增 secure-path/per-machine Computer Use helper artifact，
   不能只把 helper 放进 `extraResources`。
5. **是否存在企业 all-users 安装需求。** 推荐首发没有；若有，则不能复用当前
   per-user 候选，需要单独的 per-machine 计划。

Production Full acceptance 在第 2、3 项未确认前保持 BLOCKED：必须提供预期 Ling/provider signer
subject、对应签名证书 SHA-256、被负责人接受的 Windows build allowlist 和完整
`requiredAcceptanceCells`，以及允许复核
人工证据的 reviewer 与 candidate-build attestor identity/key id/canonical SPKI SHA-256；
两类角色的 identity、key id 和 SPKI 必须跨角色互斥。
检测到任意 `Status=Valid` 证书或仅记录操作系统版本字符串都不足以关闭门禁。

负责人批准结果必须写入符合
`docs/release/evidence/windows-release-policy.schema.json` 的 policy 文件。candidate
manifest 绑定该 policy 的 SHA-256；runner 不接受命令行临时输入的 signer subject、证书
指纹、Windows build 或 reviewer key。六类人工验收证据也必须使用独立 kind、
candidate/host/session/build 绑定、与 operator 不同的 reviewer routing claim，以及
report-relative 附件 hash；该 JSON claim、空文件或 PASS 开关都不构成身份信任。最终
promotion 必须由独立 verifier 验证 policy-pinned reviewer 和 candidate-build detached
signatures。

生产负责人签字前，代码、schema、runner 和 handoff 可以完成并合并。Windows 同事可用
test-signed Setup 完成真实机器功能验收并给出
`promotionStatus="INTERNAL_TEST_PASS"`；此时仍是 `releaseReady=false`。生产输入或证据未闭合时，
实现生命周期只能记录为“等待 production release inputs”，不得伪装成新的
`promotionStatus`，也不得标记 Windows support
release-ready。只有 production candidate 的外部验证输出 `RELEASE_PASS` 才能发布。
