# Ling Desktop Windows 发布决策记录

日期：2026-07-17

状态：工程策略已冻结，产品/发布负责人签字仍待完成
适用范围：Desktop Computer Use PiP 首个 Windows x64 候选

本文是实现计划 T15.5 的决策证据。它区分已经写入代码的工程约束和必须由产品、
法务或发布负责人确认的发行选择。未确认项不得在 Windows VM 验收期间临时决定。

## 已冻结的工程约束

### Provider exact allowlist

- 首个候选只接受 `cua-driver-rs 0.8.3`，不得把 `>=0.8.3` 当成兼容保证。
- 固定上游 tag：`cua-driver-rs-v0.8.3`。
- 固定 Windows x86_64 asset：
  `cua-driver-rs-0.8.3-windows-x86_64.zip`。
- 固定 asset size：`10,585,087 bytes`。
- 固定 SHA-256：
  `6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0`。
- daemon provider health 和 Windows VM smoke 都必须拒绝未审阅的更高版本。

Provider 升级只能通过独立 PR。该 PR 必须同时更新 verifier、runtime allowlist、VM
smoke、CI 和本文，并重新完成来源/许可证/SHA、schema/tools、真实窗口生命周期、升级
和回滚验收。不得自动跟随 GitHub `latest`。

### Provider 发行风险

上游 `cua-driver-rs-v0.8.3` 发布于 2026-07-15，GitHub release 标记为
`prerelease=true`。当前审阅的 `cua-driver.exe` 和 `cua-driver-uia.exe` 都没有 PE
certificate table，不能声称已通过 Authenticode 或 SmartScreen 信任。

因此 `0.8.3` 只允许进入内部或 beta 验收。公开生产发布默认继续阻塞，直到上游提供
签名稳定资产；若产品和发布负责人决定接受预发布/未签名 provider，必须留下显式风险
接受记录，不能由 Ling 静默重签第三方二进制。

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

### 证书与第三方边界

- Ling 的 app、uninstaller 和 NSIS 必须由 Ling 法律发布实体拥有的组织证书签署。
- 禁止个人开发者证书、多人共享 PFX 或把可导出的长期私钥直接存入普通 CI secret。
- 优先使用 Azure Trusted Signing 或组织控制的云 HSM/EV 签名服务。
- TryCua provider 应由上游签署；Ling 不私自重签第三方 provider。

### 回滚单元

发布与回滚单元是不可拆分的：

```text
(Ling Desktop version + exact provider version + provider SHA-256)
```

保留上一套已验收的签名 Ling 安装包和 provider 资产。任一签名、health、PID/HWND
身份、真实捕获、安装或升级门禁失败时停止发布并整体回退到上一 tuple；禁止只热换
provider 后继续沿用旧证据。

## 待负责人确认

1. **公开发行是否接受当前预发布且未签名的 provider。** 推荐不接受，只用于内部/beta。
2. **Ling Publisher 法律名称和签名服务。** 需要在 Azure Trusted Signing 与组织控制的
   云 HSM/EV 方案中选择，并配置 CI 身份与审计责任人。
3. **Windows 支持下限。** Electron 43.1.1 只提供“Windows 10 及以上”的框架边界，
   Ling 仍需选择实际产品范围。推荐首发收窄到 Windows 11 x64，并以真实 VM build
   矩阵写明具体版本；若支持 Windows 10 或多个 Windows 11 版本，必须逐项增加验收。
4. **是否存在首发企业 all-users 安装需求。** 推荐首发没有；若有，则不能复用当前
   per-user 候选，需要单独的 per-machine 计划。

负责人签字前，T15.5 状态只能是 `implemented-awaiting-owner-decision`，不得标记完成。
