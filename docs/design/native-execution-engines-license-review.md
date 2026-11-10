# 原生引擎依赖替代与许可检查

日期：2026-10-18。状态：**兼容替代已实现，当前主机的依赖许可检查通过；目标平台分发验收未完成**。

用户决定保持现行许可政策，不增加 Unknown/LGPL 豁免，同时保留 Claude 连接探测和图像安全处理能力。本文件记录实现、已验证范围及分发边界，不作法律合规结论。

## 替代对象与当前实现

基线为 `708931accf7bc7de4d67abf2939500e1369969a2`。原分支引入的 Claude Agent SDK 自定义条款被 pnpm 归为 Unknown，sharp 的 libvips 声明 LGPL，均不符合现行仓库允许清单。原始失败日志 `continuation-license-check.log` 保留为历史记录。

| 原依赖 | 用途 | 已实现替代 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk@0.3.263` | Claude 配置连接探测 | 所选本机 Claude Code CLI 的公开 `auth status --json`，不发送 prompt |
| `sharp@0.34.5` 及 libvips 平台包 | 原生 PNG/JPEG/WebP 产物验证和规范化 | 产品自有 Rust 图像 helper，通过有界 stdin/stdout 与 Node 桥接 |

两条依赖已从包声明和 lockfile 移除，执行 `pnpm install --ignore-scripts` 完成依赖同步。Kimi 使用的 MIT `@anthropic-ai/sdk@0.112.1` 保留。测试 PNG 解码使用 MIT `pngjs@7.0.0`，不是运行时替代 codec。

## Claude 公开 CLI 探测

当前明确支持 Claude Code `2.1.156`，调用：

```text
claude --bare --setting-sources= --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' --strict-mcp-config auth status --json
```

保留稳定 engineId `claude-agent-sdk`，避免更名导致 profile 与历史引用漂移；该标识不代表仍依赖同名 SDK。临时 HOME/config、环境白名单和所选 secretRef 隔离认证；不继承用户 Claude 账号或设置，不发模型请求。stdout/stderr 合计 64 KiB；严格 UTF-8、唯一 JSON、正常 close 后才接受；继续执行版本、来源、权限/凭据漂移、超时、取消、子进程回收和清理失败否决检查。

`auth status` 的 firstParty / api_key / ANTHROPIC_API_KEY 元数据只能证明所选配置已就绪，结果仍为 `configured_unverified`，不能证明密钥远端有效、模型可用或具备 Claude 执行能力。本次未扩展 Claude Run target。

验证：Claude 合同 40/40、共用认证/连接回归 83/83；真实本机 2.1.156 使用明确的 synthetic 假 key，验证无 prompt 的隔离公开命令与正常清理。后者不算真实账号或推理验收。证据在外部 `claude-cli-replacement/`，其中 `green-claude-contract-dependency-closed.log` 是删除依赖后的终态；早期报告里的 39/40 是历史依赖尚未移除的结果。

## 图像 helper 与保留能力

源码位于 `packages/daemon/native/image-sanitizer/`，Node 桥接为 `native-image-sanitizer.ts`。只接受原始 PNG/JPEG/WebP 字节和 maxPixels，不接受路径/URL。实际解码、处理 EXIF 1–8 方向、把有界 ICC 转为 sRGB、保留 alpha，然后编码只含 IHDR/IDAT/IEND 的新 PNG。保留动画拒绝、严格 CRC/zlib/JPEG entropy 检查和既有安全发布逻辑。

输入/输出各 25 MiB、像素最多 3,200 万、ICC 最多 4 MiB。helper 使用 512 MiB requested live heap 分配预算；它不等于系统 RSS/线程栈硬限制。Node 负责 5 秒处理截止、取消、进程终止、等待 close、两秒清理窗口和管道容量。异常/超时/非零退出/缺 close 都不发布图像。

JPEG 库 `jpeg-decoder@0.3.2` 有最小严格 entropy 补丁，仅修改 `huffman.rs`。本次已核实原 crate、补丁和来源摘要；构建记录 vendor 源摘要，不宣称构建器自动重建并验证上游补丁来源。详见 helper 的 `VALIDATION.md` 和 provenance 文件。

### 色彩兼容边界

独立参考来自之前安装的 sharp 生成的微型 synthetic 样本；sharp 已不是构建或运行依赖。PNG/WebP 方向样本的 RGB 最大舍入差 1，JPEG 4:4:4 方向和 P3 样本最大差 2，alpha 必须逐值相同。带 ICC 的 CMYK 样本最大差 21，差异来自 CMS 插值；原始 CMYK 分量与独立解码逐值一致。不承诺与 libvips/LCMS 像素等价。

无 profile CMYK 用常规公式，不猜隐式印刷 profile。极小高反差 JPEG 4:2:0 与 libvips 最大差 61，来自色度上采样；这些差异明确保留，不能包装为“像素完全一致”。公开 artifact 测试经过生产 materialize 路径检查独立预期像素、方向和元数据清除。

## 许可与构建守门

实际 active Rust normal/build 依赖为 18 个版本：16 个选择 MIT，moxcms 与 pxfm 选择 BSD-3-Clause。完整通知和真实许可文本随 helper 分发。Cargo.lock 中 inactive 的 zlib-rs 未被启用/编译，不是新增许可豁免。

构建使用实际 `cargo tree --edges normal,build` 图和 metadata，逐项检查已审核 inventory、锁定 checksum、许可文本摘要和通知全文。同名同版本但不同来源的歧义直接拒绝；新启用的 optional、未审核依赖或许可/通知漂移均使构建失败。没有修改仓库全局允许清单。

构建锁定 Cargo.lock、显式本机 target 和输出目录，记录源码、二进制和通知摘要。Desktop 带入固定 helper、metadata、notices 路径；资源缺失阻止启动。metadata 是签名前构建证据，不是签名后 attestation 或原生引擎认证。当前没有 helper 专用 afterPack 缺件门禁，不能声称直接绕过标准构建也绝不会产出缺件包。

当前主机 `check:licenses` 通过：1,218 个版本、23 个许可族，无豁免。Rust 实际编译图和原生通知另由 helper build guard 检查，不把 JS 扫描冒充全平台 SBOM。

## 剩余验收

当前源码及 helper 测试针对 macOS arm64。Windows、macOS x64、正式签名/公证/安装包、实际资源布局与运行，仍需在相应目标验收；GitHub CI 配置已接入 Ubuntu Rust 合同测试和 macOS host codec 重建，本轮没有运行远端 CI。源码/依赖检查通过不等于所有分发义务已经确认。

其他引擎的真实账号、平台和 surface 仍分别验收。缺可信证据的生产组合继续 blocked，不能因为本次替代通过而自动启用。完整状态见 [验收记录](native-execution-engines-validation.md)。
