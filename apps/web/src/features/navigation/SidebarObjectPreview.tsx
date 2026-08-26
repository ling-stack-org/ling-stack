import { Folder, GitBranch } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import type { SidebarObjectContext } from "../../app/sidebar-object-context.js";
import { Icon } from "../../shared/ui/index.js";

export function SidebarObjectPreview({
  context,
  title,
}: {
  readonly context: SidebarObjectContext;
  readonly title: string;
}): React.JSX.Element {
  return (
    <span className="sidebar-object-preview">
      <strong>{title}</strong>
      {context.git ? (
        <>
          <span><Icon icon={Folder} size="xs" />{context.git.repositoryLabel}</span>
          <span><Icon icon={GitBranch} size="xs" />{context.git.branchName}</span>
        </>
      ) : null}
      <time dateTime={context.activityAt}>{formatDateTime(context.activityAt)}</time>
    </span>
  );
}
