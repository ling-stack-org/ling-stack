import type { ResponseLanguage } from "@ling-stack/core";

export type LingMaterializationCopyIssue =
  | "image_unavailable"
  | "pdf_unavailable"
  | "office_unavailable"
  | "link_private"
  | "workspace_file_outside_root"
  | "generic_unavailable";

export function renderMaterializationClarifyCopy(input: {
  readonly issue: LingMaterializationCopyIssue;
  readonly label: string;
  readonly language: ResponseLanguage;
}): string {
  if (input.language === "zh-CN") {
    switch (input.issue) {
      case "image_unavailable":
        return `我没能读取 ${input.label} 的图片内容。你可以换一个可读图片，或把关键内容贴出来。`;
      case "pdf_unavailable":
        return `我没能读取 ${input.label} 的 PDF 内容。你可以换一个可读文件，或把需要处理的内容贴出来。`;
      case "office_unavailable":
        return `我没能读取 ${input.label} 的文档内容。你可以换一个可读文件，或把关键内容贴出来。`;
      case "link_private":
        return "这个链接看起来是本机或私有地址，我不会自动打开。你可以贴正文，或让我作为受控任务检查它。";
      case "workspace_file_outside_root":
        return "这个路径不在当前工作区内。请换成工作区里的文件，或让我通过受控任务先检查它。";
      case "generic_unavailable":
        return `我没能读取 ${input.label}。你可以换一个可读文件，或把需要处理的内容贴出来。`;
    }
  }
  switch (input.issue) {
    case "image_unavailable":
      return `I could not read image content from ${input.label}. Upload a readable image, or paste the relevant details.`;
    case "pdf_unavailable":
      return `I could not read PDF content from ${input.label}. Upload a readable file, or paste the section to use.`;
    case "office_unavailable":
      return `I could not read document content from ${input.label}. Upload a readable file, or paste the section that matters.`;
    case "link_private":
      return "I will not open local/private links automatically. Paste the content, or ask me to inspect it as a controlled task.";
    case "workspace_file_outside_root":
      return "That path is outside this workspace. Use a workspace file, or ask me to inspect it as a controlled task.";
    case "generic_unavailable":
      return `I could not read ${input.label}. Upload a readable file, or paste the content to use.`;
  }
}
