# 独立插件打包与分发

## 状态

三个独立仓库维护各自的源码、构建流程和发布文档。Office 和 Chrome 已生成 macOS arm64、Windows x64 开发候选，Cua Driver 已完成双平台锁定构建。Desktop 的兼容包和瘦包均已通过两平台开发安装启动验证。正式插件发布待接入 macOS Developer ID 和公证、Windows Authenticode 及 Cua Driver 完整性目录签名。Desktop 默认使用兼容打包，正式签名资产、官方目录和安装版验收完成后再切换。[Cua Driver 平台锁](https://github.com/ling-stack-org/ling-plugin-cua-driver/pull/5)

| 插件 | 独立仓库职责 | Ling 主仓职责 |
| --- | --- | --- |
| [Office Documents](https://github.com/ling-stack-org/ling-plugin-office-documents) | Apple Events 与 Excel COM helper、原生构建和发布文档 | 文件级 Office 工具、审批、`ling.office.driver.v1` 宿主、恢复和界面 |
| [Ling for Chrome](https://github.com/ling-stack-org/ling-plugin-chrome-browser) | Manifest V3 扩展、Rust Native Host、Chrome Web Store 文档和资产 | Native Messaging 注册、受信任主机路径、配对、工具授权和会话 |
| [Cua Driver](https://github.com/ling-stack-org/ling-plugin-cua-driver) | 上游版本和补丁、provider 构建、复现与提升证据、第三方许可 | Desktop 进程监督、平台信任、审批、租约和系统权限 |

## 包与目录

官方插件包是 `.ling-plugin.zip`，包含 `.ling-plugin/plugin.json`、`.ling-plugin/checksums.json` 和 `.ling-plugin/provenance.json`。manifest 固定插件 ID、版本、artifact ID、平台和架构。包内运行文件、许可证及其他载荷逐项记录 SHA-256。

Desktop 通过 daemon 从 `official-plugin-catalog` 分支读取 `catalog.json` 与 `catalog.sig`，使用内置 Ed25519 目录公钥验签。daemon 按 Ling 版本、系统、架构和渠道选择包。下载使用 HTTPS，GitHub Release 跳转限定在其资产服务。daemon 校验归档大小、SHA-256 和独立的包签名。原生包另有运行文件清单签名，Desktop 可离线复验。

`LING_PLUGIN_CATALOG_FILE` 支持使用本地开发目录测试市场展示和安装流程。正式 Desktop 使用内置发行公钥验证原生缓存。

## 原生运行时

daemon 验证归档签名后解压到暂存目录，校验 ZIP 路径、逐文件摘要、manifest 身份和版本兼容性，再将原生包发布到用户级缓存。

```text
~/.ling-stack/plugins/cache/host/official-remote/<plugin>/<version>/<platform>/<arch>/<digest-prefix>/
~/.ling-stack/plugins/cache/host/current/<plugin>.json
```

选择记录在同一次原子替换中保存当前版本与上一版本。回滚前复验包、平台和 Ling 版本。用户正常退出再启动 Ling 时，Desktop 离线验证选中版本的运行文件并接管新进程。工作区读取同一用户级签名包的版本和回滚状态，各自保存插件启用状态、授权和审计。首次安装包后仍需在工作区启用插件。

Office helper 和 Chrome Native Host 优先使用通过验证的缓存，兼容构建可使用包内资源。Cua Driver 的按需模式由 Desktop 包提供运行信任策略。它沿用平台代码签名、系统权限、交互会话、进程隔离和租约检查。Cua Driver 无缓存时保留 Desktop 管理边界，外部进程无法取得该托管运行权。

## 发布

- `GET /plugins/catalog` 获取已验签的目录及匹配本机平台、架构和 Ling 版本的官方包。
- `POST /plugins/:id/install-remote` 安装初始版本或更新到指定版本。
- `POST /plugins/:id/check-update` 返回当前版本和最新匹配版本。
- `POST /plugins/:id/rollback` 复验并恢复缓存的上一版本。

`scripts/plugins/package-plugin.mjs` 与 `generate-catalog.mjs` 提供本地开发工具。生产者仓库发布固定版本。主仓的 Official plugin catalog 工作流对照审核的资产摘要复核版本、来源、包内容和平台运行文件，再生成签名。工作流输入采用以下格式。

```json
{
  "official:office-documents": { "tag": "vX.Y.Z", "sourceSha": "<commit>", "sha256": { "darwin-arm64": "<digest>", "win32-x64": "<digest>" } },
  "official:chrome-browser": { "tag": "vX.Y.Z", "sourceSha": "<commit>", "sha256": { "darwin-arm64": "<digest>", "win32-x64": "<digest>" } },
  "official:cua-driver": { "tag": "vX.Y.Z", "sourceSha": "<commit>", "sha256": { "darwin-arm64": "<digest>", "win32-x64": "<digest>" } }
}
```

发布记录应包含平台签名、实际运行、第三方许可及源码证据。Cua Driver 只接受对应平台已提升的锁定构建和生产签名载荷，并随包保存 seal、锁文件和许可证。Windows 还需要经过验证的完整性 catalog。

## 候选构建证据

- 使用隔离用户配置、本地开发目录和临时包签名，Office 候选在真实 daemon 中通过首次安装、更新、重新读取和离线回滚。macOS helper 在三个阶段均响应 `driver_status`。更新测试使用同一 helper 的另一归档版本。macOS 候选 helper 的预检识别到 Excel 16.91 正在运行，并返回 `permission_required`。签名版仍需经过系统 Automation 授权和实际工作簿操作验收。自动化回归覆盖空工作区安装、跨工作区显示和回滚、保留工作区启用状态，以及缓存篡改拒绝。
- Ling for Chrome 的 macOS 候选包在真实 Chrome 的隔离配置中验证了 Native Messaging 自动连接、全部六项浏览器工具、暂停恢复以及禁用后重新启用。Chrome Web Store 发布的 0.1.2 与候选归档的可执行代码及弹窗文件逐项一致，差异在四个图标、更新地址和商店元数据。商店安装的扩展仍需和正式签名的 Native Host 一起验收。[Chrome 候选构建](https://github.com/ling-stack-org/ling-plugin-chrome-browser/actions/runs/45081594739) · [Chrome Web Store](https://chromewebstore.google.com/detail/ling-for-chrome/mbmlnnfhebclljonhedpjghbhibfapei)
- Cua Driver 的独立复核根据四个原始归档核对了源码提交、补丁、二进制摘要和两平台锁。新锁在四台独立 runner 上完成原生重建与 MCP 探针，macOS 的 7 个稳定文件和 Windows 的 8 个稳定文件分别逐项一致。Windows 探针覆盖 Medium 完整性、状态目录用户 ACL、链接拒绝和配置持久化。发布文档记录这批签名前产物的来源和后续平台签名步骤。[Cua Driver 发布文档](https://github.com/ling-stack-org/ling-plugin-cua-driver/blob/main/docs/RELEASE.md)

### Desktop 安装包对照

四个候选均从 `14be1bdebd3d295a4f822981ae8cc18a32b9dd51` 构建，使用 Electron 45.3.1，各平台的两种模式使用同一版 gstack 源码及适配。各 runner 独立生成资源清单。Windows 候选未签名，macOS 候选使用 ad-hoc 签名。四个开发包均未包含正式 Cua Driver provider。[兼容包](https://github.com/ling-stack-org/ling-stack/actions/runs/45187207804) · [瘦包](https://github.com/ling-stack-org/ling-stack/actions/runs/45187216178)

| 平台和产物 | 兼容包（字节） | 瘦包（字节） | 减少 |
| --- | ---: | ---: | ---: |
| Windows x64 EXE | 788,970,364 | 743,359,378 | 45,610,986（5.781%） |
| Windows x64 解包后常规文件 | 2,667,154,374 | 2,531,662,583 | 135,491,791（5.080%） |
| macOS arm64 DMG | 794,378,186 | 793,969,911 | 408,275（0.051%） |
| macOS arm64 ZIP | 787,617,589 | 787,220,728 | 396,861（0.050%） |
| macOS arm64 解包后常规文件 | 2,213,099,697 | 2,212,017,079 | 1,082,618（0.049%） |

四组均在隔离配置下通过资源鉴权、连接 Desktop 自有 daemon、加载主窗口和正常退出。Windows 两组还通过安装、同版本覆盖安装和卸载。macOS 两组从已校验的 DMG 复制应用后冷启动。兼容包与瘦包的资源鉴权用时在 Windows 分别为 78.603 和 114.198 秒，在 macOS 分别为 84.168 和 141.566 秒。交互界面、正式插件调用和已有配置迁移仍待签名版验收。

早期 macOS runner 的完整启动在资源准备阶段超时。同批 DMG 的 daemon-only 探针记录了兼容包与瘦包的资源鉴权用时，分别为 115.672 和 136.420 秒，均超过原先的 60 秒上限。当前 macOS 和 Windows 安装版为资源鉴权预留 180 秒，收到鉴权回执后有独立的 20 秒服务就绪时限。[测量运行](https://github.com/ling-stack-org/ling-stack/actions/runs/45177615505)

瘦包插件索引修复提交 `b60f0c396` 的 macOS arm64 和 Windows x64 开发包均通过归档校验与安装启动。Windows 还通过同版本覆盖安装及卸载。[候选构建复验](https://github.com/ling-stack-org/ling-stack/actions/runs/45293564788/attempts/2)

### macOS 已有配置切换

macOS arm64 使用同一隔离用户目录，从 `14be1bdeb` 的兼容开发包切到 `b60f0c396` 的瘦包。两次均连接 Desktop 自有 daemon、加载主窗口和正常退出。切换前后，主工作区保持 Office 和 Chrome 启用，第二工作区保持 Office 禁用。MCP 绑定、工作区写入审批和已有插件启停事件也通过了切换前后对照。瘦包使用构建保留的诊断 DMG，镜像和应用的 ad-hoc 签名均通过本机校验。[修复和验证记录](https://github.com/ling-stack-org/ling-stack/pull/808)

在另一个测试配置中，已留存两代 gstack 资源时，加载第三代会触发 `packaged_skill_history_retention_limit` 并中断启动。上面的单次切换复用了只有一代资源的配置。默认打包切换前仍需验证不同资源留存状态的现有配置。

## 瘦包对照和切换

1. 在相同的已独立审核源码提交和工具链上，分别构建兼容基线和 `LING_PLUGIN_EXTERNAL_ONLY=1` 的瘦包。仍需通过平台原有的 Desktop 发布前置检查。
2. Cua Driver 独立运行验证另设 `LING_CUA_DRIVER_CATALOG_MANAGED=1`。macOS 从发布环境读取 `LING_CUA_DARWIN_EXPECTED_TEAM_ID`。Windows 读取 `LING_CUA_PROVIDER_SIGNER_SUBJECT`、`LING_CUA_PROVIDER_SIGNER_SHA256`、`LING_CUA_CATALOG_SIGNER_SUBJECT` 和 `LING_CUA_CATALOG_SIGNER_SHA256`。这些信息属于 Desktop 的生产 provider 信任策略。
3. 在 macOS arm64 和 Windows x64 安装版验证离线启动、首次下载、实际调用、更新、回滚和已有配置迁移。macOS 的 `office-local.node` 仍由 Desktop 的文件级 Office 能力使用，适用现有独立审查。
4. 记录 DMG、EXE 和解包后常规文件的字节数、首次下载大小，以及启动和回滚后实际执行的版本与摘要。Desktop 包报告提供 `pluginMode` 与 `installedPayloadBytes`。平台签名及 Excel、Chrome、Computer Use 实测单独记录。
5. 平台验收通过后切换默认打包，清理三个插件的重复原生构建、资源和源码，更新 Desktop 发布说明。
