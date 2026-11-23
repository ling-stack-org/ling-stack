# Ling 官方插件目录

三个平台插件在各自仓库维护源码、构建和发布文档。主仓维护插件接口、运行时接入和目录签名。

| 插件 | 独立仓库 |
| --- | --- |
| Office Documents 原生 Excel helper | [ling-plugin-office-documents](https://github.com/ling-stack-org/ling-plugin-office-documents) |
| Ling for Chrome 扩展与 Native Host | [ling-plugin-chrome-browser](https://github.com/ling-stack-org/ling-plugin-chrome-browser) |
| Cua Driver provider | [ling-plugin-cua-driver](https://github.com/ling-stack-org/ling-plugin-cua-driver) |

Official plugin catalog 工作流复核三个仓库的固定 Release、源码 commit 及各平台包的 SHA-256，生成 `catalog.json` 和 `catalog.sig`。选择正式发布时将快照写入 `official-plugin-catalog` 分支。客户端使用内置公钥验证目录、下载包和运行文件清单。

本地开发目录可用以下命令生成。

```sh
node scripts/plugins/package-plugin.mjs --platform darwin --arch arm64 --channel dev
node scripts/plugins/generate-catalog.mjs
```

设置 `LING_PLUGIN_CATALOG_FILE` 后，daemon 从目录文件旁的 `dist/` 读取 `local-dev` 包。正式 Desktop 的原生运行时需要通过发行公钥验证。

[打包、运行时和切换验收](../docs/design/plugin-independent-packaging.md)
