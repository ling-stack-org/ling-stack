# GitHub Actions 桌面候选构建

工作流是 [Desktop candidate](../../.github/workflows/desktop-prerelease.yml)（沿用原工作流文件路径）。它固定一个完整源码 SHA，
分别在原生 macOS arm64、Windows x64 runner 上构建，默认仅生成 **Actions artifacts**。
手动选择 `create_draft=true` 时，才会在两平台都成功后汇总为一个 **Draft release**，不强制标记 prerelease。
macOS 使用 ad-hoc 签名，不含 Developer ID 或公证；Windows 不含 Authenticode 发行者签名。
两种开发包都不需要先购买代码签名证书。

## 首次配置

1. 合入工作流以及对应平台的构建适配，保持仓库 Actions 开启。
2. 使用 GitHub-hosted `macos-26` 和 `windows-2025` runner；不需要配置本机 runner。
   工具由工作流安装，Node、pnpm、Rust、Go、Bun 使用明确版本，依赖使用锁文件。
3. 不新增 PAT、签名证书或模型 API Key。构建 job 只有 `contents: read`；
   只有手动选择创建 Draft 的汇总 job 使用内置 `GITHUB_TOKEN` 的 `contents: write`。
4. 首先运行 `inspect`，下载两个 `desktop-evidence-*` artifact。
   `inspect` 成功表示诊断报告已收集，**不表示原生审批、分发材料或安装包验收通过**。
5. 按报告补齐并独立审查平台输入。Mac 的编译器、SDK、headers、源码闭包和
   Electron/OS 指纹必须与静态审查记录匹配；流水线不会根据测试成功自动批准它们。

仓库现有编译/打包流程仍是唯一打包入口。gstack 从固定的上游 commit 生产，随包提供本平台的
FFmpeg 与原生工具；不会复制开发者全局安装或静默省略资源。
浏览器功能保留，首次使用时从官方固定版本下载 Chrome for Testing，校验 ZIP 大小、SHA 和完整文件清单后，
原子写入应用自己的缓存；之后可离线复用。Windows 首次下载约 201 MB。下载失败会阻止浏览器服务启动，
可重试，不会退回系统浏览器或未经校验的文件。普通应用启动和停止浏览器服务不会触发下载。
安装包只包含浏览器固定版本、官方地址和校验信息，不转发 Chrome 二进制，也不宣称已取得其再分发授权。
TestSavant 模型保留完整推理功能，权重在首次扫描时从官方固定版本下载，逐文件验证大小和 SHA，
成功后保存在应用自己的缓存中，后续本地运行。首次使用需要联网；模型下载中或失败时会明确阻止扫描通过。
安装包仅包含模型固定版本和校验信息，不代表获得了权重的再分发授权。
`releaseEligible: false` 和未完成的 installed-client 验收会保留，不能被解释为正式产品就绪。
原生审查失配、缺少实际资源或未解决的分发材料缺口都会阻止候选包进入汇总。

## 每次发版

发布目标仓库固定为 `ling-stack-org/ling-stack`：必须在该仓库运行工作流、创建 Draft 并最终发布
`v0.1.3`。当前本地 checkout 的 `origin` 指向 `tianxiaochannel-oss88/ling-stack`；在那里
创建的 Release 不会被 Desktop 配置的 `ling-stack-org/ling-stack` 更新检查发现。
发布前核对目标仓库中的源码 SHA 和 tag，历史 `v0.1.2-alpha.1` 不复用或移动。

1. 在发布 PR 中将根 `VERSION`、根 `package.json`、Desktop `package.json` 的版本改为相同的
   SemVer 产品版本，本次为 `0.1.3`，完成审查和测试后合入主分支。
2. 选取已审查的完整 40 位 commit SHA；新 tag 使用 `v<版本>`，本次为 `v0.1.3`。
   不使用移动分支作为源码输入，不复用已有 tag 或 Release。
3. 在 `ling-stack-org/ling-stack` 的 GitHub **Actions → Desktop candidate → Run workflow** 中选择：

   | 输入 | 值 |
   | --- | --- |
   | Workflow ref | `main` |
   | `operation` | 先 `inspect`，解决阻断后再 `build` |
   | `source_sha` | 已合入 main 的完整源码 SHA |
   | `release_tag` | 与上述三个版本文件一致的新 release tag，例如 `v0.1.3` |
   | `create_draft` | `false` 仅保留候选 artifact；`true` 在两平台成功后创建 Draft |

4. 下载并检查本次生成的安装包、每平台验证 JSON、分发材料压缩包和 `checksums.txt`。
   Mac 输出 arm64 DMG/ZIP；Windows 输出 x64 Setup EXE。没有 Intel Mac、Windows ARM64 或自动升级产物。
5. 在测试账号/测试机完成安装、启动、真实模型任务、退出重启、卸载，以及本版本涉及的
   Office、浏览器、Computer Use 等功能验收，记录未覆盖项。流水线会在临时 Windows runner
   验证静默安装、同版本覆盖升级、完整文件比对、Electron 启动和卸载清理；这些检查与归档校验
   不能替代真实桌面和模型验收，见 [开发候选验收](development-packages.md)。
   两端还会在私有缓存中验证随包 CLI 的真实浏览器首次下载、页面交互、停止及缓存重启，
   保存 `browser-acquisition-smoke.json`。零请求缓存检查和不可用代理重启属于受控网络模拟，
   不代表操作系统断网或完整 GUI、模型、Office 验收。
6. 维护者核对 Draft 内容与证据、完成适用的签名与发行门禁后，再决定是否手动发布。
   工作流不会自动取消 Draft、完成签名或验收、发布 Release、重写 tag 或覆盖已有资产。
   只有发布在 `ling-stack-org/ling-stack`、`draft=false` 且 `prerelease=false` 的合格 Release，
   才有机会被 GitHub `/repos/ling-stack-org/ling-stack/releases/latest` 返回；Draft 或 prerelease 均不会出现。
   本工作流的 unsigned 开发候选和 Draft 本身不证明具备正式发布资格。

命令行也可以触发，示例中的 SHA 和版本必须替换为本次真实输入：

```bash
gh workflow run desktop-prerelease.yml --repo ling-stack-org/ling-stack --ref main \
  -f operation=inspect \
  -f source_sha=REPLACE_WITH_REVIEWED_FULL_COMMIT_SHA \
  -f release_tag=v0.1.3 \
  -F create_draft=false
```

## 合入前的云端验证

同仓库 PR 可由维护者添加 `desktop-package-inspect` 标签，收集真实双平台诊断。
`desktop-package-build` 标签执行双平台完整候选构建；两者都不会创建 Release。
外部 fork 的标签不会触发此流程。新提交后需要重新添加对应标签来检查新 SHA。
这让构建适配可以在合入前验证；它不代替主分支 CI 和独立源码审查。

## 失败与恢复

- 一个平台失败时，不创建单平台 Release；保留可用诊断供定位。
- Mac runner 镜像或源码变化使审查指纹失配时，先取新观察证据并完成独立审查，不能自动刷新批准记录。
- notices/SBOM 必须来自当前版本和本次资源生产结果；旧 Release 的材料不能当作当前依赖的原文证据。
- Draft 创建后上传或摘要校验失败，会保留未发布 Draft 并让 job 失败。
  先检查该 Draft，选用新版本/新 tag 重试；脚本不会自动删除或覆盖残留资产。
- 所有正常分发仍须满足 [第三方声明边界](../../THIRD_PARTY_NOTICES.md#binary-distribution-boundary)。
  无证书开发候选与正式签名/公证验收分别记录。
