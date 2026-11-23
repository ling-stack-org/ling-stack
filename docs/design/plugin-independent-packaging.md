# 独立插件打包与分发

## 状态

三个生产者仓库已承接各自的源码、构建和发布文档。Office 和 Chrome 的 macOS arm64、Windows x64 候选归档已通过构建。Cua Driver 的 Windows x64 原生构建和 macOS arm64 复核候选已完成双跑，两个平台锁提案均待独立复核。正式签名资产、首次目录发布、两个平台的安装验收和体积对照是默认瘦包切换的前置条件。迁移期间保留兼容打包。

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

- `GET /plugins/catalog` 获取已验签的目录和本机兼容包。
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
- Windows x64 未签名开发包对照使用同一源码 `0621af8a89e513bcc6cfd23820c921a18c71c3da`、Electron 45.3.1 和同版 gstack。两个 runner 独立生成的 gstack 清单摘要不同。瘦包 EXE 从 788,979,385 减到 743,359,437 字节，降幅 5.78%。解包后常规文件从 2,667,154,320 减到 2,531,662,529 字节，降幅 5.08%。两组均通过空白配置安装、资源鉴权、连接自有 daemon、加载主窗口、正常退出、同版本覆盖安装和卸载。兼容包和瘦包的资源准备分别耗时 133.4 秒和 135.1 秒。交互界面、三个插件和已有配置迁移仍需正式安装版验收。[兼容包验证](https://github.com/ling-stack-org/ling-stack/actions/runs/45134711982/job/137558831585) · [瘦包验证](https://github.com/ling-stack-org/ling-stack/actions/runs/45124319679/job/137525817393)
- macOS arm64 的同源码开发对照固定在 `e3eb23bcee73a614e02c1b2fd48c6b38c1995bfb`。两组通过 App 的 ad-hoc 代码签名、DMG 校验和与 ZIP 完整性检查。DMG 从 271,297,948 减到 270,888,791 字节，ZIP 从 261,662,802 减到 261,263,318 字节，解包后常规文件从 780,023,183 减到 778,940,565 字节。开发对照未纳入包内 gstack，也未纳入生产 Cua Driver provider。完整资源候选的云端检查通过了 gstack 和受限命令运行时指纹，15 项 Office addon 原生输入均匹配，源码 `0621af8a89e5` 在 Office 打包闭包的独立审查前置检查停止。完整资源 DMG 仍需在独立审查后重新构建，验证安装、首次启动和体积。[macOS 开发对照](https://github.com/ling-stack-org/ling-stack/actions/runs/45073421597) · [macOS 完整资源候选](https://github.com/ling-stack-org/ling-stack/actions/runs/45124319679/job/137525817396)
- Ling for Chrome 的 macOS 候选包在真实 Chrome 的隔离配置中验证了 Native Messaging 自动连接、全部六项浏览器工具、暂停恢复以及禁用后重新启用。Chrome Web Store 发布的 0.1.2 与候选归档的可执行代码及弹窗文件逐项一致，差异在四个图标、更新地址和商店元数据。商店安装的扩展仍需和正式签名的 Native Host 一起验收。[Chrome 候选构建](https://github.com/ling-stack-org/ling-plugin-chrome-browser/actions/runs/45081594739) · [Chrome Web Store](https://chromewebstore.google.com/detail/ling-for-chrome/mbmlnnfhebclljonhedpjghbhibfapei)
- Cua Driver 的 Windows x64 两次原生构建通过。两个 runner 验证了 Medium 完整性、状态目录用户 ACL、链接拒绝、配置持久化和 MCP 会话，8 个产物摘要一致。按产物 ID 下载的复验生成了字节一致的平台锁提案，状态为 `MANUAL_REVIEW_REQUIRED`。平台锁通过独立复核并提交后，须重新生成绑定该锁的原生构建证明。[Windows A/B](https://github.com/ling-stack-org/ling-plugin-cua-driver/actions/runs/45086277445) · [Windows 平台锁提案复验](https://github.com/ling-stack-org/ling-plugin-cua-driver/actions/runs/45091335162)
- 已提交的 Darwin 平台记录绑定补丁集 `edb89636dab1`。使用 `2262742c7256` 的两次原生构建均未命中原最终链接摘要。复核分支固定两台 runner 都观测到的 `0edf30c01f3b`，两个 macOS arm64 原生构建和运行探针通过，7 个稳定产物摘要一致。Darwin 平台锁提案更新补丁集和签名前可执行文件摘要，状态为 `MANUAL_REVIEW_REQUIRED`。独立复核并更新正式输入锚点后，还需重建绑定新锁的原生产物。[原 macOS A/B](https://github.com/ling-stack-org/ling-plugin-cua-driver/actions/runs/45090597255) · [macOS 复核候选](https://github.com/ling-stack-org/ling-plugin-cua-driver/actions/runs/45098824506) · [Cua Driver 发布说明](https://github.com/ling-stack-org/ling-plugin-cua-driver/blob/main/docs/RELEASE.md)

## 瘦包对照和切换

1. 在相同的已独立审核源码提交和工具链上，分别构建兼容基线和 `LING_PLUGIN_EXTERNAL_ONLY=1` 的瘦包。仍需通过平台原有的 Desktop 发布前置检查。
2. Cua Driver 独立运行验证另设 `LING_CUA_DRIVER_CATALOG_MANAGED=1`。macOS 从发布环境读取 `LING_CUA_DARWIN_EXPECTED_TEAM_ID`。Windows 读取 `LING_CUA_PROVIDER_SIGNER_SUBJECT`、`LING_CUA_PROVIDER_SIGNER_SHA256`、`LING_CUA_CATALOG_SIGNER_SUBJECT` 和 `LING_CUA_CATALOG_SIGNER_SHA256`。这些信息属于 Desktop 的生产 provider 信任策略。
3. 在 macOS arm64 和 Windows x64 安装版验证离线启动、首次下载、实际调用、更新、回滚和已有配置迁移。macOS 的 `office-local.node` 仍由 Desktop 的文件级 Office 能力使用，适用现有独立审查。
4. 记录 DMG、EXE 和解包后常规文件的字节数、首次下载大小，以及启动和回滚后实际执行的版本与摘要。Desktop 包报告提供 `pluginMode` 与 `installedPayloadBytes`。平台签名及 Excel、Chrome、Computer Use 实测单独记录。
5. 平台验收通过后切换默认打包，清理三个插件的重复原生构建、资源和源码，更新 Desktop 发布说明。
