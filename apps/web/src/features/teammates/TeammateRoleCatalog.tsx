import type { AiTeammateTemplate } from "@ling-stack/core/skill-types";
import { Brain, ChevronRight, UserPlus } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button } from "../../shared/ui/index.js";
import { teammateRoleIcon } from "./teammate-role-icons.js";

export function TeammateRoleCatalog({
  selectedTemplateId,
  showCreateAction,
  templates,
  onCreate,
  onOpenTemplate,
}: {
  readonly selectedTemplateId?: string;
  readonly showCreateAction: boolean;
  readonly templates: readonly AiTeammateTemplate[];
  readonly onCreate: () => void;
  readonly onOpenTemplate: (template: AiTeammateTemplate) => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <section
      className="teammate-role-catalog"
      aria-label={t("Teammate templates")}
      data-ui2-teammate-role-catalog
    >
      <header className="teammate-role-catalog-header">
        <span className="teammate-role-catalog-heading">
          <Brain aria-hidden="true" />
          <h2>{t("Default roles")}</h2>
        </span>
        {showCreateAction ? (
          <Button
            className="teammate-role-catalog-create"
            aria-label={t("New AI teammate")}
            leadingIcon={<UserPlus />}
            size="sm"
            variant="primary"
            onClick={onCreate}
          >
            {t("New teammate")}
          </Button>
        ) : null}
      </header>

      <div className="teammate-role-catalog-list" role="list">
        {templates.map((template) => {
          const name = t(template.name);
          const summary = t(template.summary);
          return (
            <Button
              key={template.id}
              className="teammate-role-catalog-row"
              aria-pressed={template.id === selectedTemplateId}
              leadingIcon={teammateRoleIcon(template.roleKey)}
              title={`${name}: ${summary}`}
              trailingIcon={<ChevronRight />}
              variant="ghost"
              onClick={() => onOpenTemplate(template)}
            >
              <span className="teammate-role-catalog-copy">
                <strong>{name}</strong>
                <small>{summary}</small>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
