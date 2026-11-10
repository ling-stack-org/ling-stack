# 原生 Codex 候选验收

用于已获授权的独立临时工作区测试。此工具使用构建后的真实 probe 和 owned execution，
不启动生产 dispatcher，不修改用户配置，不发布生产认证。需要事先构建相关 workspace 包；
工具本身不会安装依赖或自动编译。

```sh
node scripts/native-execution-engines/verify-codex.mjs --config /absolute/test-config.json --output /absolute/new-private-report
```

配置只允许以下字段。`executablePath` 必须指向当前平台的原生二进制本体，不能是 npm
的 `codex.js` launcher。当前固定命令场景使用 POSIX `/usr/bin/touch`；Windows 需单独
实现并验收相应场景，不算本工具的已验证平台。

```json
{
  "executablePath": "/absolute/path/to/native/codex",
  "model": "approved-test-model",
  "provider": "approved_test_provider",
  "providerConfiguration": {
    "name": "Approved test provider",
    "base_url": "https://approved-provider.example/v1",
    "wire_api": "responses"
  },
  "credentialEnvironment": "LING_NATIVE_CANDIDATE_API_KEY"
}
```

通过本次进程环境提供指定变量，不要把密钥放进命令参数、配置文件、版本库或验收报告。
变量名必须以 `LING_NATIVE_CANDIDATE_` 开头。provider 使用固定
`requires_openai_auth=true` 与临时 file auth；不会复制用户的 hooks、MCP 或插件配置。
URL 不允许内嵌凭证、查询参数或 fragment；HTTP 仅允许 loopback。

输出必须是仓库外的全新目录，父目录已存在。报告与记录使用私有权限、禁止覆盖。
工具自行冻结源码和实际 package dist 字节，并在运行后复核；分别稳定不证明构建与源码
对应，报告会明确该限制及依赖字节仅通过 lockfile 关联的限制。

固定候选场景包括连接、无工具精确回复、SQLite 重开同 native binding 恢复、turn 开始
后的取消、唯一临时 touch 命令批准与拒绝、唯一文件的原生 apply_patch。任何其他审批
默认拒绝，失败或未知状态阻止后续写场景。记录包含持久 submission/审批关联、事件序列、
文件内容摘要与子进程/回调排空事实；原始密钥、认证文件内容和任意异常正文不写入报告。

另有 `candidateObservations.productionRejection`：经现有嵌入接口使用不访问钥匙串的
降级凭据解析器并关闭浏览器 broker，启动隔离 daemon，保存显式 v2 授权后经真实
HTTP/RunStore 路径核对缺证据时的拒绝和 canonical 输入关联。它不注入 target、
安装探测或 accepted evidence，也不发模型请求。完整默认启动仍为 `not_run`；
生产 target 当前固定 `openai` provider，其他 provider 的 owned 候选成功不代表
生产配置等价。起停或请求无法确认排空时，保留临时目录及隔离环境，不继续清理。

`candidateObservations` 只表示这些窄场景的结果。完整 release checks、生产调度与资源
准入、跨工作区约束、身份认证及签名目标包验收仍为 `not_run`，不能拿候选报告导入
`RunnerAcceptanceStore`。`productionCertification` 和 `published` 始终为 `false`。
完整可信检查编排与发布后生产请求验收仍属于 [T7 计划](../../docs/design/native-execution-engines-implementation-plan.md)。

退出码：场景/身份/清理失败为 1，候选场景成功但完整验收有缺项为 2。此版本不会返回
生产验收成功。排空确认后只移除本次临时根目录；无法确认时报告失败并保留目录供定位，
不要把它当作安全清理完成。

```sh
node --test scripts/native-execution-engines/verify-codex.test.mjs
node --test packages/daemon/test/native-codex-candidate.test.mjs
```

后者需要已有构建产物，使用受控协议 peer 验证工具行为，不能认证真实引擎。
其新增 HTTP 拒绝用例只允许版本探测，并核对未发生原生任务提交。
