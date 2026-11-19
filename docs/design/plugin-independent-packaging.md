# 独立插件打包与分发

## 状态

第一阶段已实现协议、静态 catalog 校验、远程 artifact 下载、SHA-256/成员 checksums 校验、版本缓存、原子 current 指针和回滚指针。健康检查失败时会尝试恢复上一版本并重新检查。当前仍保留 Desktop 的 embedded 兼容资源；在两个正式版本的迁移窗口结束前不能移除这些资源。设置 `LING_PLUGIN_EXTERNAL_ONLY=1` 可在迁移完成后构建不携带旧插件资源的 Desktop 包。

## 包与 catalog

官方插件包是 `.ling-plugin.zip`，根目录必须包含 `.ling-plugin/plugin.json`、`checksums.json` 和 `provenance.json`。远程包的 manifest 使用 `manifestVersion: 2`、`sourceKind: official-remote` 和 `trustLevel: official`，并固定 `artifactId`、平台和架构。

`plugins/catalog.json` 是静态目录。客户端只接受 HTTPS 地址，校验插件 ID、版本、平台、架构、artifact URL、文件大小和 SHA-256。正式发布时由 CI 生成 `catalog.sig`，并通过 `LING_PLUGIN_CATALOG_PUBLIC_KEY` 启用签名校验；插件 artifact 可使用 `LING_PLUGIN_ARTIFACT_PRIVATE_KEY` 生成 Ed25519 签名，并由客户端 `LING_PLUGIN_ARTIFACT_PUBLIC_KEY` 校验。本地开发目录允许 `signatureVerified: false`。

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
