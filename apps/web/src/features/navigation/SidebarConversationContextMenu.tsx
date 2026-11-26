import { Trash2 } from "lucide-react";
import { useRef, type CSSProperties, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  InlineFeedback,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "../../shared/ui/index.js";

export interface SidebarConversationContextTarget {
  readonly conversation: {
    readonly id: string;
    readonly label: string;
  };
  readonly x: number;
  readonly y: number;
}

export function SidebarConversationContextMenu({
  target,
  onClose,
  onDelete,
}: {
  readonly target?: SidebarConversationContextTarget;
  readonly onClose: () => void;
  readonly onDelete: (conversation: SidebarConversationContextTarget["conversation"]) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if (!target) return null;

  const anchorStyle = {
    left: `${target.x}px`,
    opacity: 0,
    pointerEvents: "none",
    position: "fixed",
    top: `${target.y}px`,
    width: 1,
    height: 1,
  } satisfies CSSProperties;

  return (
    <Menu modal={false} open onOpenChange={(open) => { if (!open) onClose(); }}>
      <MenuTrigger asChild>
        <button
          aria-hidden="true"
          tabIndex={-1}
          type="button"
          style={anchorStyle}
        />
      </MenuTrigger>
      <MenuContent
        align="start"
        className="sidebar-conversation-context-menu"
        side="bottom"
        sideOffset={4}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <MenuItem
          aria-label={t("Delete conversation")}
          tone="danger"
          onSelect={() => onDelete(target.conversation)}
        >
          <Icon icon={Trash2} size="xs" />
          {t("Delete conversation")}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function SidebarConversationDeleteDialog({
  busy,
  error,
  fallbackFocusRef,
  returnFocusRef,
  target,
  onClose,
  onConfirm,
}: {
  readonly busy: boolean;
  readonly error?: string;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly target?: SidebarConversationContextTarget["conversation"];
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const displayName = target?.label ?? "";

  return (
    <Dialog
      busy={busy}
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="sidebar-conversation-delete-dialog"
        data-ui2-sidebar-conversation-delete-dialog=""
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const returnTarget = returnFocusRef.current;
          if (returnTarget?.isConnected) {
            returnTarget.focus({ preventScroll: true });
            return;
          }
          fallbackFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          description={t("This permanently deletes messages, attachments, goals, and plans. Historical runs remain but will no longer be linked to this conversation.")}
          title={t("Delete conversation {title}?", { title: displayName })}
        />
        <DialogBody className="sidebar-conversation-delete-dialog-body">
          {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            leadingIcon={<Trash2 aria-hidden="true" />}
            loading={busy}
            loadingLabel={t("Deleting...")}
            size="sm"
            variant="danger"
            onClick={() => void onConfirm()}
          >
            {t("Delete conversation")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
