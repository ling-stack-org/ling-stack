# 业务数据与 API 历史兼容边界加固实施计划

本文执行 `business-compatibility-boundary-hardening.md`，基于最新 `origin/main`，与主题分支隔离。

## 分支与提交边界

- 分支：`gansx/business-compatibility-hardening`
- 基线：`origin/main` 在 2026-10-29 的 `c128146c5cf874fa4717dbb23b5743c31be27e27`
- 目标：独立 PR 合并到 `main`
- 允许范围：Core runner identity/read projections、SQLite mutable migration、daemon parser/continuation boundaries、兼容回归测试和本计划文档
- 禁止范围：主题图片、主题 CSS/token、主题设计文档、用户数据库和本地服务配置

## WP0：基线和 source audit

记录 Node/pnpm、迁移头、现有兼容测试，并扫描 `permissionMode`、`permissionPreset`、`pi-coding-agent`、`prompt_legacy` 和 `apps/web/src/types.ts` 的 production caller。审计输出只保存文件/行号和 fixture 形状，不保存密钥、用户路径或媒体正文。

退出条件：确认没有主题文件进入分支 diff；明确每个旧字段属于 v1 decoder、历史 mapper 还是错误的新写入。

## WP1：单一 runner identity 与读取投影

新增 `packages/core/src/runner-ids.ts`，接入 Core export、daemon runner registry 和所有公开 parser。Core 的 run/runtime/control-plane/continuation/harness/user-input mapper 统一对历史 JSON 返回规范投影。投影只改身份字段，用户 prompt、日志和 unknown runner 保持原值。

测试：旧 alias 在 run/task/teammate/automation/channel/readiness 边界归一；历史 snapshots/events/context 的 stored bytes/fingerprint 不变但 API 投影为 `pi`；用户文本中的 `pi-coding-agent` 不被替换。

## WP2：迁移安全性

把 runner migration 的职责限定为可变 scalar binding。不可变 JSON 不由 migration 重写。迁移仍在单事务中运行，重复启动是 no-op，更新或 marker 失败回滚。

测试：旧 scalar rows 被规范化；snapshot/context JSON 原文不变；malformed JSON 不再成为迁移失败原因；scalar 更新中途失败不产生部分写入。

## WP3：continuation 和权限边界

在 user-input preparation/wait 读取路径保留 stored/projected 双值，用 stored fingerprint 校验；v2 权限旧字段拒绝和 v1 历史读回归保持不变。检查 daemon 新入口只产生 canonical runner/permission/media shape。

测试：历史 continuation 恢复、重放和指纹校验；v2 legacy write 稳定返回 `legacy_permission_fields_removed`；legacy media create 被拒绝，历史 evidence 仍可读。

## WP4：Web/API caller 收口

只迁移真正的 daemon DTO caller 到 contracts/api-client；保留 Web-only form state 和旧 response projection。source audit 必须证明新 request builder 不发送 v2 旧权限字段。

退出条件：API adapter、contracts、Core、Daemon、Web typecheck/build 和相关 E2E 全绿。

## WP5：联合验证与 PR

串行执行 Core build/test、Daemon typecheck/test、contracts/api-client test、Web typecheck/build、兼容 E2E、`git diff --check` 和主题文件审计。推送分支、创建 PR、等待全部 CI；只在 CI 和 review 通过后合并。

## 明确不做

- 不删除历史 SQLite 迁移、旧权限读取、legacy media decoder、Web response projection 或主题存储迁移。
- 不重写真实数据库，不修改主题资源，不把主题分支内容混入业务 PR。
- 不在没有 API 版本发布、旧客户端退出和历史归档证据时删除兼容层。
