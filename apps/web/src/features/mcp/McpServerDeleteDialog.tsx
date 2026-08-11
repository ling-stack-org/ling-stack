import { Trash2 } from "lucide-react";
import { useRef, type MutableRefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  InlineFeedback,
  InspectorSection,
} from "../../shared/ui/index.js";
import type { McpServer } from "../../types.js";
import { McpDetailList } from "./McpDetailList.js";

export function McpServerDeleteDialog({
  busy,
  errorMessage,
  onConfirm,
  onOpenChange,
  open,
  returnFocusRef,
  server,
}: {
  readonly busy: boolean;
  readonly errorMessage?: string;
  readonly onConfirm: () => Promise<boolean>;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly returnFocusRef: MutableRefObject<HTMLButtonElement | null>;
  readonly server?: McpServer;
}): React.JSX.Element {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const remove = async (): Promise<void> => {
    const removed = await onConfirm();
    if (removed) onOpenChange(false);
  };

  return (
    <Dialog
      busy={busy}
      dismissible
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus({ preventScroll: true });
        }}
      >
        <DialogHeader
          closeLabel={t("Close")}
          title={t("Delete MCP server?")}
          description={server ? t("{name} will be permanently removed from this workspace.", { name: server.displayName }) : undefined}
        />
        <DialogBody>
          {errorMessage ? (
            <>
              <InlineFeedback tone="danger">
                {t("The MCP server could not be deleted. Review details and try again.")}
              </InlineFeedback>
              <InspectorSection title={t("Error details")} summary={t("Needs attention")}>
                <McpDetailList items={[{ labelKey: "Last operation error", value: errorMessage }]} />
              </InspectorSection>
            </>
          ) : (
            <InlineFeedback tone="warning">
              {t("This permanently removes the server, its synced tools, and its AI teammate bindings.")}
            </InlineFeedback>
          )}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} disabled={busy} variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="danger"
            leadingIcon={<Trash2 />}
            loading={busy}
            loadingLabel={t("Deleting server")}
            onClick={() => void remove()}
          >
            {t("Delete server")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
