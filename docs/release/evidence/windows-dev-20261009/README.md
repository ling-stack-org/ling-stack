# Windows 开发包与实机测试记录（2026-10-09）

Windows x64 开发安装包已完成构建，安装后的真实程序通过模型对话、文件读取与生成、会话保存，以及独立测试环境中的系统重启和卸载检查。程序版本为 0.1.2-alpha.1，未签名；完整图形界面、Office 互操作和 Computer Use 验收仍未完成。

## 下载与固定源码

- [开发预发布页面](https://github.com/ling-stack-org/ling-stack/releases/tag/windows-dev-0.1.2-alpha.1-20261009-f0a632b)
- [Windows x64 安装包](https://github.com/ling-stack-org/ling-stack/releases/download/windows-dev-0.1.2-alpha.1-20261009-f0a632b/Ling-Stack-0.1.2-alpha.1-windows-x64-f0a632b-setup.exe)
- [匹配的固定源码](https://github.com/ling-stack-org/ling-stack/releases/download/windows-dev-0.1.2-alpha.1-20261009-f0a632b/ling-stack-source-f0a632b.zip)
- [脱敏证据包](https://github.com/ling-stack-org/ling-stack/releases/download/windows-dev-0.1.2-alpha.1-20261009-f0a632b/windows-dev-evidence-20261009.zip)
- [SHA-256 校验清单](https://github.com/ling-stack-org/ling-stack/releases/download/windows-dev-0.1.2-alpha.1-20261009-f0a632b/SHA256SUMS.txt)

安装包对应固定源码 **f0a632b1bd5bd09b12778cbd7da3d26c354b832f**，基础提交为 b529a4b475f41442b29b59ff5bfeeece8879c74e。开发预发布标签指向实际打包提交；PR 新增报告、将来合并或 squash 得到的提交号不作为此安装包的构建输入。

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| Ling-Stack-0.1.2-alpha.1-windows-x64-f0a632b-setup.exe | 246639272 | 2BB170CE7BD16032CBBA5CBE56EE655FCDAED46C80F9DE94F1231BA7A19C50A9 |
| ling-stack-source-f0a632b.zip | 42867630 | E7A1C009D5164C30FA0E0040F6DD5867AE9DE4E793EB63D46BD112A35BC70F54 |

安装后的主程序 SHA-256：BD0AED10D7ECBE4643D4974456EDDBC41330F8BA9365AD9FEB0E30CFF016FA66。

## 两处源码修复

1. Windows Office Driver：Execute 中以 object 接收 Excel COM 对象，让分发到已定义的 mutation 方法时按静态类型绑定，解决编译失败。COM 对象的后续处理沿用原实现；运行时 Office 互操作没有在本轮验收。
2. Daemon CLI：仅在 darwin 调用 macOS restricted-command bootstrap，解决 Windows 安装后启动时因 restricted_command_packaged_platform_invalid 而退出。Windows 直接调用该 macOS 发现函数仍会拒绝，未放宽原生组件的平台检查。

## 实测结果

所有测试均使用本表中相同 SHA-256 的安装包。模型任务通过已安装程序的后台 API 执行，窗口加载日志和进程检查不等于图形界面操作验收。

| 验证项 | 结果 | 范围 |
| --- | --- | --- |
| 完整 Windows 打包 | PASS | desktop package:win 退出码 0，生成 x64 NSIS 安装包 |
| 安装、启动 | PASS | 当前用户静默安装、文件与登记核对，后台健康检查及窗口加载记录 |
| 本地模型真实对话 | PASS | Qwen3 1.7B，17 + 25 = 42 |
| 应用自带启动和退出测试 | PASS | headless smoke 两次，正常退出后端口释放 |
| 再次启动、保存的会话 | PASS | 重启程序后查到原任务及回答；普通窗口清理使用强制停止 |
| 实际系统重启 | PASS | 重启后读取原会话和模型设置，并完成 19 + 23 = 42 的新任务 |
| 卸载 | PASS | 静默卸载后核对程序、卸载登记、快捷方式及浏览器主机登记清理 |
| 当前用户模型连接、对话 | PASS | 复用已有 gpt-6.1-sol / OpenAI Responses 配置，连接检查通过，17 + 25 = 42 |
| 当前用户模型文件任务 | PASS | read → write → read 均成功；一次性批准测试文件写入；明细 30、50、15 元，总额 95 元 |
| 当前模型配置和会话保存 | PASS | 保存的默认模型、凭据存在及完成后的对话记录得到核对 |
| 普通界面配置、发送任务、点击退出及截图 | NOT_RUN | 没有图形界面操作和截图证据 |
| Office 运行互操作、Computer Use、锁屏及多显示器/DPI | NOT_RUN | 构建成功不作为这些功能验收证据 |

生命周期测试使用独立用户数据、测试项目和本地模型。后来按用户要求重新安装并复用当前模型，完成中文对话与文件任务，应用保留安装及运行状态；该轮没有再次退出重启、重启系统或卸载。两轮结果分别保存在 [lifecycle-test.json](lifecycle-test.json) 与 [current-model-test.json](current-model-test.json)，不能互相替代。

文件任务输出见 [功能测试结果.md](功能测试结果.md)，SHA-256 为 3EB5A52C4B51A016E710DB8BCC949E7BC903B2C1DDB2973EA31CDE7C02BBF414。

## 环境与限制

实测系统为 Windows 11 专业工作站版 x64，10.0.26200。构建环境：Git 2.55.0.windows.3、Node 22.22.1、pnpm 10.0.0、Rust/MSVC 1.97.1、VS Build Tools 17.14.36、MSVC 14.44、Windows SDK 10.0.26100.0、.NET SDK 8.0.424。包内 Electron 44.5.1 / Node 24.21.0。详细版本见 [tool-versions.json](tool-versions.json)。

目标平台为 Windows 10/11 x64；只有 Windows 11 已实测。Windows 7/8/8.1、32 位 Windows 不支持；未提供 ARM64 原生包，也未验证仿真运行。

开发包采用 unsigned_dev + development，未启用 bundled Cua Driver。没有 Authenticode 发行者签名或 SmartScreen 交互验收，不作为正式发布及完整产品验收通过的证据。

本地 Qwen 冷启动曾超过连接检查超时；最终通过结果以先加载模型权重为前提。当前用户模型测试的启动诊断仍有 secret_store_unavailable 警告，指系统钥匙串不可用；应用本地保存的模型凭据可完成实际调用。

公开记录仅包含合成测试数据、结果、版本与哈希，不包含模型密钥、内部连接地址、完整模型配置、用户数据库、备份、会话原文或机器私有路径。大体积安装包通过预发布附件交付，未放入 Git 历史。

## 合并影响与验证

与已核对的远端 main（b529a4b）相比，源码只改动 Office Driver 中一个局部变量的类型，以及 daemon CLI 的平台入口条件。未修改依赖锁文件、数据库结构、配置格式、服务端 API 或发布流水线。macOS 入口保持原调用路径；Windows 和 Linux 跳过仅供 macOS 使用的发现流程。Office 的运行时互操作和 macOS 真实运行仍需对应平台验证。

本次实际打包、Windows 安装后启动与任务检查通过；提交 PR 前再次执行 Windows bootstrap 的拒绝检查以及 dotnet build --configuration Release --no-restore，均通过。原生构建为 0 错误、1 个原有 CS8601 可空引用警告，该位置不在本次修改中。对已核对 main 的 merge-tree 模拟无冲突；创建 PR 后应以 GitHub 最新的可合并状态及 CI 结果作为合并依据。
