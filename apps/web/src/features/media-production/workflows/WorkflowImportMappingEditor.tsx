import type { MediaWorkflowInputField, MediaWorkflowOutputRule } from "../../../types.js";
import { SelectControl } from "../../../shared/components/SelectControl.js";
import type { MediaWorkflowImportDraft } from "./media-workflow-types.js";

const semantics: readonly { readonly value: MediaWorkflowInputField["semantic"]; readonly label: string }[] = [
  { value: "prompt", label: "提示词" },
  { value: "negative_prompt", label: "负面提示词" },
  { value: "ratio", label: "画面比例" },
  { value: "duration", label: "视频时长" },
  { value: "seed", label: "随机种子" },
  { value: "reference_image", label: "参考图片" },
  { value: "custom", label: "自定义参数" },
];

export function WorkflowImportMappingEditor({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: MediaWorkflowImportDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>) => void;
}): JSX.Element {
  return (
    <div className="media-workflow-import-editor">
      <div className={`media-workflow-validation${draft.analysis.validation.ok ? " is-ok" : " is-blocked"}`}>
        <strong>{draft.analysis.validation.ok ? "节点检查通过" : "节点检查未通过"}</strong>
        <span>识别到 {draft.analysis.nodeClasses.length} 类节点、{draft.inputFields.length} 个输入和 {draft.outputRules.length} 个输出。</span>
        {draft.analysis.validation.errors.map((message) => <p className="inline-error" key={message}>{message}</p>)}
        {draft.analysis.validation.warnings.map((message) => <p className="media-workflow-warning" key={message}>{message}</p>)}
      </div>

      <div className="media-workflow-form-row two-columns">
        <label className="field">
          <span>流程名称</span>
          <input value={draft.name} disabled={disabled} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>用途说明</span>
          <input value={draft.description} disabled={disabled} placeholder="例如：生成 5 秒产品分镜" onChange={(event) => onChange({ description: event.target.value })} />
        </label>
      </div>

      <section className="media-workflow-mapping-section">
        <div className="media-workflow-section-head">
          <div><strong>输入映射</strong><span>只暴露场景生产需要填写的安全字段。</span></div>
        </div>
        <div className="media-workflow-mapping-list">
          {draft.inputFields.map((field, index) => (
            <div className="media-workflow-mapping-row" key={field.id}>
              <input
                aria-label={`输入 ${index + 1} 名称`}
                value={field.label}
                disabled={disabled}
                onChange={(event) => onChange({ inputFields: replaceAt(draft.inputFields, index, { ...field, label: event.target.value }) })}
              />
              <SelectControl
                aria-label={`输入 ${index + 1} 用途`}
                value={field.semantic}
                disabled={disabled}
                onChange={(event) => onChange({
                  inputFields: replaceAt(draft.inputFields, index, { ...field, semantic: event.target.value as MediaWorkflowInputField["semantic"] }),
                })}
              >
                {semantics.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
              </SelectControl>
              <label className="media-workflow-required-toggle">
                <input
                  type="checkbox"
                  checked={field.required}
                  disabled={disabled}
                  onChange={(event) => onChange({ inputFields: replaceAt(draft.inputFields, index, { ...field, required: event.target.checked }) })}
                />
                必填
              </label>
              <details><summary>节点字段</summary><code>{field.nodeId} / {field.inputName}</code></details>
            </div>
          ))}
        </div>
      </section>

      <section className="media-workflow-mapping-section">
        <div className="media-workflow-section-head">
          <div><strong>输出结果</strong><span>选择要回收为 Ling 产物的图片或视频。</span></div>
        </div>
        <div className="media-workflow-mapping-list">
          {draft.outputRules.map((rule, index) => (
            <div className="media-workflow-mapping-row output" key={`${rule.nodeId}:${index}`}>
              <span>输出 {index + 1}</span>
              <SelectControl
                value={rule.artifactType}
                disabled={disabled}
                onChange={(event) => onChange({
                  outputRules: replaceAt(draft.outputRules, index, { ...rule, artifactType: event.target.value as MediaWorkflowOutputRule["artifactType"] }),
                })}
              >
                <option value="video">视频</option>
                <option value="image">图片</option>
              </SelectControl>
              <SelectControl
                value={rule.collect}
                disabled={disabled}
                onChange={(event) => onChange({
                  outputRules: replaceAt(draft.outputRules, index, { ...rule, collect: event.target.value as MediaWorkflowOutputRule["collect"] }),
                })}
              >
                <option value="all">收集全部</option>
                <option value="first">只取第一个</option>
              </SelectControl>
              <details><summary>输出节点</summary><code>{rule.nodeId}</code></details>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function replaceAt<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}
