import type { ConversationTranscript, ConversationTurn, TranscriptBlockBase } from "../transcript/types.js";

export interface ConversationTranscriptFixture {
  readonly id: string;
  readonly label: string;
  readonly transcript: ConversationTranscript<ConversationTurn<TranscriptBlockBase>>;
}

export const conversationTranscriptFixtures = [
  transcriptFixture("plain-answer", "Plain answer", [
    block("coordinator_message", "answered", "可以直接在当前会话里完成。", "succeeded"),
  ]),
  transcriptFixture("command-only-work", "Command-only work", [
    block("operation", "shell", "运行 `pnpm typecheck`", "running", "tsc 正在检查"),
    block("final_result", "result", "类型检查完成。", "succeeded"),
  ]),
  transcriptFixture("operation-running", "Operation running", [
    block("operation", "running-shell", "Engineer 正在运行 `pnpm typecheck`", "running", "最新输出持续更新"),
  ]),
  transcriptFixture("approval", "Approval needed", [
    block("operation", "pending-command", "准备执行 shell 命令", "waiting_for_approval"),
    block("approval", "shell-approval", "需要你确认执行 `pnpm install`。", "waiting_for_approval"),
  ]),
  transcriptFixture("operation-waiting-approval", "Operation waiting approval", [
    block("operation", "waiting-file-edit", "Docs 请求写入 `docs/design/conversation-ui.md`", "waiting_for_approval", "等待文件写入授权"),
    block("approval", "file-edit-approval", "审批后才会修改设计文档。", "waiting_for_approval"),
  ]),
  transcriptFixture("artifact-producing-work", "Artifact-producing work", [
    block("operation", "edit", "更新会话 UI 组件", "succeeded"),
    block("artifact_strip", "artifacts", "2 个文件变更，1 个截图预览", "succeeded"),
    block("final_result", "result", "实现已完成并通过检查。", "succeeded"),
  ]),
  transcriptFixture("operation-terminal-folded", "Terminal operation folded", [
    block("operation", "terminal-folded", "QA 已完成浏览器 smoke", "succeeded", "1 项检查通过"),
    block("final_result", "terminal-folded-result", "页面无 console error。", "succeeded"),
  ]),
  transcriptFixture("operation-terminal-expanded", "Terminal operation expanded", [
    block("operation", "terminal-expanded", "Release 已完成发布前检查", "succeeded", "展开后显示命令输出", {
      mode: "inline",
      title: "命令输出",
      summary: "保留有界输出，避免终态行吞掉证据。",
      lines: [
        { id: "terminal-expanded:line-1", text: "$ pnpm lint", tone: "muted" },
        { id: "terminal-expanded:line-2", text: "0 errors", tone: "success" },
      ],
    }),
    block("artifact_strip", "terminal-expanded-artifacts", "1 个 diff artifact 可预览", "succeeded"),
  ]),
  transcriptFixture("requirement-shaping", "Requirement shaping", [
    block("requirement_shaping", "scope", "Product 与 Architect 已收敛范围。", "running"),
    block("decision_needed", "decision", "需要决定是否第一阶段开放并行 verification branch。", "waiting_for_approval"),
  ]),
  transcriptFixture("serial-multi-agent", "Serial multi-agent", [
    block("operation", "workflow", "按 Product -> Engineer -> QA 顺序推进", "running"),
    block("agent_activity", "product", "Product: 明确验收口径", "succeeded"),
    block("agent_activity", "engineer", "Engineer: 正在实现", "running"),
  ]),
  transcriptFixture("parallel-multi-agent", "Parallel multi-agent", [
    block("operation", "parallel-workflow", "并行读取规划分支与验证分支", "running"),
    block("agent_activity", "planner", "Planner: 读取需求上下文", "running"),
    block("agent_activity", "verifier", "Verifier: 检查 artifact-only 结果", "running"),
  ]),
  transcriptFixture("blocked-work", "Blocked work", [
    block("operation", "blocked-command", "等待外部服务恢复", "blocked"),
    block("decision_needed", "next-step", "可以重试、切换 mock，或暂停。", "blocked"),
  ]),
  transcriptFixture("interrupted-redirect", "Interrupted redirect", [
    block("operation", "cancelled", "原任务已停止", "cancelled"),
    block("operation", "redirected", "已创建后续任务接续新指令", "queued"),
  ]),
] as const satisfies readonly ConversationTranscriptFixture[];

function transcriptFixture(
  id: string,
  label: string,
  blocks: readonly TranscriptBlockBase[],
): ConversationTranscriptFixture {
  const turnId = `fixture-turn:${id}`;
  return {
    id,
    label,
    transcript: {
      schemaVersion: 1,
      surfaceId: `fixture:${id}`,
      turns: [{
        id: turnId,
        sourceMessageId: `fixture-message:${id}`,
        blocks: blocks.map((item) => ({ ...item, turnId })),
      }],
    },
  };
}

function block(
  kind: TranscriptBlockBase["kind"],
  id: string,
  text: string,
  status: TranscriptBlockBase["status"],
  meta?: string,
  expanded?: TranscriptBlockBase["expanded"],
): TranscriptBlockBase {
  return {
    id,
    turnId: "",
    kind,
    status,
    revision: 1,
    display: [{
      id: `${id}:line`,
      text,
      ...(meta ? { meta } : {}),
    }],
    ...(expanded ? { expanded } : {}),
  };
}
