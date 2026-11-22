# 独立插件打包与分发

## 状态

第一阶段已实现协议、静态 catalog 校验、远程 artifact 下载、SHA-256/成员 checksums 校验、版本缓存、原子 current 指针和回滚指针。健康检查失败时会尝试恢复上一版本并重新检查。当前仍保留 Desktop 的 embedded 兼容资源；在两个正式版本的迁移窗口结束前不能移除这些资源。设置 `LING_PLUGIN_EXTERNAL_ONLY=1` 可在迁移完成后构建不携带旧插件资源的 Desktop 包。

## 包与 catalog

官方插件包是 `.ling-plugin.zip`，根目录必须包含 `.ling-plugin/plugin.json`、`checksums.json` 和 `provenance.json`。远程包的 manifest 使用 `manifestVersion: 2`、`sourceKind: official-remote` 和 `trustLevel: official`，并固定 `artifactId`、平台和架构。

`plugins/catalog.json` 是静态目录。客户端只接受 HTTPS 地址，校验插件 ID、版本、平台、架构、artifact URL、文件大小和 SHA-256。正式发布时由 CI 生成 `catalog.sig`，客户端必须配置 `LING_PLUGIN_CATALOG_PUBLIC_KEY` 并通过签名校验；只有通过 `LING_PLUGIN_CATALOG_FILE` 指定的本地开发目录允许 `signatureVerified: false`。插件 artifact 可使用 `LING_PLUGIN_ARTIFACT_PRIVATE_KEY` 生成 Ed25519 签名，并由客户端 `LING_PLUGIN_ARTIFACT_PUBLIC_KEY` 校验。

## 运行时边界

远程下载先写入临时目录，解压时拒绝绝对路径、反斜杠、`.`、`..` 和目录逃逸，校验 ZIP CRC、包大小、manifest 身份和版本兼容性后才写入：

```text
~/.ling-stack/plugins/cache/<plugin>/<version>/<platform>/<arch>/<sha256>/
~/.ling-stack/plugins/current/<plugin>.json
~/.ling-stack/plugins/rollback/<plugin>.json
```

current 指针使用临时文件加 rename 原子替换。新版本安装前保存上一版本指针，回滚只切换到已校验且仍存在的缓存目录；插件内容不会在下载或校验阶段执行。

## 路由与发布

- `GET /plugins/catalog`：读取官方静态 catalog。
- `POST /plugins/:id/install-remote`：按平台、架构、channel 和可选版本安装。
- `POST /plugins/:id/rollback`：恢复上一版本。
- `POST /plugins/:id/check-update`：根据固定 catalog 快照返回当前版本、最新版本和可用 artifact。

`scripts/plugins/package-plugin.mjs` 生成 artifact、成员 checksums 和 provenance；`generate-catalog.mjs` 从 sidecar 和包内 manifest 生成 catalog；`verify-catalog-assets.mjs` 在上传前逐个比对 Release 资产的大小、SHA-256、ZIP 元数据和 catalog。`.github/workflows/plugin-release.yml` 负责矩阵打包、草稿 Release 和资产上传。

CUA Driver、Chrome 和 Office 都有官方包 manifest/构建入口；发布 workflow 会先构建 Chrome 扩展或 Office helper，再将资源放入独立 artifact。Chrome、Office 的真实平台二进制仍需在对应平台 runner 上完成签名后才能从 Desktop `extraResources` 移除；迁移期间保留旧资源兼容路径。

## 官方插件独立仓库迁移

目标是让三个官方插件分别拥有源码、维护文档、构建和版本发布。Ling Desktop 通过同一个官方目录安装与更新平台包，并保留工作区中的插件身份、启用状态、工具授权和审计归属。

| 项目 | 独立仓库职责 | Ling 主仓职责 |
| --- | --- | --- |
| [Ling Office Documents](https://github.com/ling-stack-org/ling-plugin-office-documents) | macOS Apple Events helper、Windows Excel COM helper、构建与发布、原生驱动维护文档 | 文件级 Office 工具、运行审批、`ling.office.driver.v1` 宿主、恢复与用户界面 |
| [Ling for Chrome](https://github.com/ling-stack-org/ling-plugin-chrome-browser) | Manifest V3 扩展、Rust Native Host、Chrome Web Store 文档与资源、平台构建 | Native Messaging 注册与受信任主机路径、配对、授予工具权限和浏览器会话 |
| [Ling Cua Driver](https://github.com/ling-stack-org/ling-plugin-cua-driver) | 固定的上游版本和补丁、provider 源码构建、复现与提升证据、第三方许可 | Desktop 进程监督、平台信任、既有审批、租约和系统权限边界 |

### 交付顺序

1. 同批创建三个生产者仓库，迁移上述源码、文档和原有可独立执行的测试。每个仓库从固定源码版本构建本平台候选包，记录源码提交、文件清单和摘要。签名与正式发布依据各平台的现有发布流程。
2. 在 Ling 中将官方目录发布端点与 Desktop Releases 的 `latest` 分离。发布目录只收录已审查的固定版本 Release 资产，记录平台、架构、兼容版本和签名。Desktop 允许 GitHub Release 的受限 HTTPS 下载跳转，并在激活前验证目录及包的签名。
3. 让 Desktop 从受验证的用户级插件缓存解析可执行资源。按现有插件 ID 保留工作区的启用状态与授权。应用启动时插件可缺省，用户安装后可启用，切换版本时等待在途操作完成。兼容构建可引用插件仓提供的固定版本资源。
4. 用同一来源和构建工具分别构建基线包与瘦包。在 macOS arm64 和 Windows x64 安装版上验证离线启动、首次下载、实际调用、版本更新、失败回滚、旧版配置迁移及原生签名。对比 DMG、EXE 与解包字节数，并检查瘦包的运行资源清单。
5. 完成过渡和平台验收后，切换默认 Desktop 打包，移除对应的内置构建、资源、重复源码以及专属校验路径。同步更新发布说明、插件开发入口和主仓架构文档。

### 发布证据

- 插件 Release 记录每个平台的文件、SHA-256、源码提交、验证结果及许可材料。
- Cua Driver candidate 和可发行 provider 仍按原有 A/B 复现、锁文件提升与系统签名要求分别验证。官方 catalog 签名不授予原生 provider 运行权限。
- Desktop 端验收记录实际激活的缓存版本及其摘要，并覆盖低版本回滚和当前进程退出后的重新加载。
- 体积报告使用固定构建来源和同一平台，分别记录安装包传输字节数和安装后的资源字节数。
