import { resolve } from "node:path";

export function resolvePackagedContinuityWorkspaces(runRoot) {
  return Object.freeze({
    continuity: resolve(runRoot, "workspace"),
    effectUnknown: resolve(runRoot, "effect-unknown-workspace"),
  });
}

function teammateIdForLabel(prompt, label, fallback) {
  const rolesMatch = prompt.match(/Available teammate roles JSON:\s*(\[[^\n]*\])/iu);
  if (!rolesMatch) return fallback;
  try {
    const roles = JSON.parse(rolesMatch[1]);
    const teammate = Array.isArray(roles)
      ? roles.find((candidate) => candidate?.label === label)
      : undefined;
    return typeof teammate?.id === "string" && teammate.id.length > 0 ? teammate.id : fallback;
  } catch {
    return fallback;
  }
}

function explicitOwner(participantId, sourceQuote) {
  return { kind: "explicit", participantId, sourceQuote };
}

function fileTarget(path) {
  return { path, sourceQuote: path };
}

export function buildPackagedContinuityIntentFixture(input) {
  const {
    prompt,
    proofFileName,
    proofContent,
    exactVerificationCommand,
  } = input;

  if (/naked-ready/i.test(prompt)) {
    return {
      action: "execute",
      reason: "The user explicitly requested a delegated execution that must prove evidence before completion.",
      execution: {
        schemaVersion: 2,
        operations: [{
          id: "create_file",
          kind: "file_create",
          targetKind: "file",
          required: true,
          dependsOn: [],
          owner: explicitOwner(
            teammateIdForLabel(prompt, "Naked Ready", "teammate_builtin_engineer"),
            "Naked Ready",
          ),
          sourceQuote: "@Naked Ready 请创建 naked-ready.txt 完成 naked-ready delegated task；只有真实 evidence 才能报告成功。",
          target: fileTarget("naked-ready.txt"),
          contentSource: {
            kind: "generated_objective",
            text: "naked-ready delegated task",
            sourceQuote: "naked-ready delegated task",
            inputOperationIds: [],
          },
        }],
      },
    };
  }

  if (/missing-provider/i.test(prompt)) {
    const command = 'node -e "process.exit(0)"';
    return {
      action: "execute",
      reason: "The user explicitly requested a bounded multi-participant workflow whose provider readiness must be checked before Host effects.",
      execution: {
        schemaVersion: 2,
        operations: [
          {
            id: "create_file",
            kind: "file_create",
            targetKind: "file",
            required: true,
            dependsOn: [],
            owner: explicitOwner("teammate_builtin_engineer", "Engineer"),
            sourceQuote: "@Engineer @QA 请协作完成 missing-provider task：Engineer 创建 missing-provider.txt；QA 执行精确命令 `node -e \"process.exit(0)\"` 验证。",
            target: fileTarget("missing-provider.txt"),
            contentSource: {
              kind: "generated_objective",
              text: "missing-provider task",
              sourceQuote: "missing-provider task",
              inputOperationIds: [],
            },
          },
          {
            id: "verify_target",
            kind: "run_command",
            targetKind: "command",
            required: true,
            dependsOn: ["create_file"],
            owner: explicitOwner("teammate_builtin_qa", "QA"),
            sourceQuote: "QA 执行精确命令 `node -e \"process.exit(0)\"` 验证",
            command: { text: command, sourceQuote: `\`${command}\`` },
          },
        ],
      },
    };
  }

  return {
    action: "execute",
    reason: "The user explicitly requested a bounded multi-participant file and verification workflow.",
    execution: {
      schemaVersion: 2,
      operations: [
        {
          id: "create_file",
          kind: "file_create",
          targetKind: "file",
          required: true,
          dependsOn: [],
          owner: explicitOwner("teammate_builtin_engineer", "Engineer"),
          sourceQuote: `由 Engineer 创建 ${proofFileName}，内容为 ${proofContent}`,
          target: fileTarget(proofFileName),
          contentSource: {
            kind: "literal",
            text: proofContent,
            sourceQuote: proofContent,
          },
        },
        {
          id: "verify_target",
          kind: "run_command",
          targetKind: "command",
          required: true,
          dependsOn: ["create_file"],
          owner: explicitOwner("teammate_builtin_qa", "QA"),
          sourceQuote: `@Engineer @QA 请协作完成一个最小可验证任务：由 Engineer 创建 ${proofFileName}，内容为 ${proofContent}；QA 执行精确命令：${exactVerificationCommand} 验证文件内容。Engineer 与 QA 都必须完成并提供真实 evidence 后才报告成功。`,
          inputs: [{ path: proofFileName, sourceQuote: proofFileName, fromOperationId: "create_file" }],
          command: { text: exactVerificationCommand, sourceQuote: exactVerificationCommand },
        },
      ],
    },
  };
}

export function extractPackagedExactCommand(prompt, fallback) {
  const direct = prompt.match(/Run the exact command:\s*([^\n\r]+)/iu)?.[1]?.trim();
  if (direct) return direct;
  const bound = prompt.match(/;\s*exact command:\s*(.+?);\s*binding:\s*\{/iu)?.[1]?.trim();
  return bound || fallback;
}
