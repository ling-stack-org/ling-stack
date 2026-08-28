# CI 运行方式

CI 会先根据 Pull Request 的变更路径选择最小安全范围：

- 只有 `README.md`、`docs/` 和文档资源变更时，只运行文档链接、公开仓库安全、密钥扫描和空白检查。
- 工作区源码变更时，`scripts/ci/classify-scope.mjs` 会沿 workspace 依赖图扩大到所有直接和间接消费者。
- `package.json`、锁文件、工作流、`scripts/`、TypeScript/构建配置等变更会进入全量 CI。
- 给 Pull Request 加上 `full-ci` 标签可以手动强制全量 CI；`main` 推送、手动运行和 nightly 运行始终走全量范围。

构建阶段只执行一次 `build:ci` 拓扑构建，并把 `dist` 作为短期 artifact 供 typecheck、单元测试和 daemon 分片复用。各包的 `test:ci` 只运行测试，不再隐式重建依赖；本地 `build`、`typecheck` 和 `test` 命令保持原有行为。

Daemon 测试拆为四个独立 shard，使用稳定的文件分配和独立的 `LING_STACK_HOME`。每个 shard 以 `--test-concurrency=1` 运行，避免测试间共享状态；新增或删除测试文件会自动重新平衡。

Daemon 专用的依赖安全测试由 `dependency-policy` lane 单独运行，因此不会在 shard 中重复执行。

本地可以用下面的命令检查分类器和 shard 分配：

```bash
node --test scripts/ci/*.test.mjs
node scripts/ci/classify-scope.mjs --files='["packages/core/src/index.ts"]'
node scripts/ci/daemon-test-shard.mjs --shard=0 --shard-count=4
```
