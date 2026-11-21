# Ling 官方插件目录

这里保存官方远程插件的静态 catalog schema 占位。插件 artifact 由 `scripts/plugins/package-plugin.mjs`
生成，发布工作流会将 artifact sidecar 汇总为 Release 资产 `catalog.json` 和 `catalog.sig`；客户端默认读取 latest Release 资产，不依赖自建服务器。

本地开发示例：

```sh
node scripts/plugins/package-plugin.mjs --platform darwin --arch arm64 --channel dev
node scripts/plugins/generate-catalog.mjs
```

使用 `LING_PLUGIN_CATALOG_FILE` 启动本地 daemon 时，`local-dev` artifact 会自动从同目录的
`dist/` 读取，不需要额外设置下载目录。

正式发布必须由 CI 生成 `catalog.sig`，并在客户端启用公钥校验。当前仓库只提交
schema 和生成器，不提交本地构建产物或伪造签名。
