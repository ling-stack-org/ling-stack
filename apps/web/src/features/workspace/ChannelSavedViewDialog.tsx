import { PencilLine, Save, Trash2 } from "lucide-react";
import { useRef, type FormEvent, type RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  InlineFeedback,
  Input,
} from "../../shared/ui/index.js";

export type ChannelSavedViewDialogState =
  | { readonly mode: "create"; readonly draft: string }
  | { readonly mode: "rename"; readonly draft: string; readonly viewId: string; readonly viewName: string }
  | { readonly mode: "delete"; readonly viewId: string; readonly viewName: string };

export function ChannelSavedViewDialog({
  busy,
  error,
  fallbackFocusRef,
  returnFocusRef,
  state,
  onClose,
  onDraftChange,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly error: string;
  readonly fallbackFocusRef: RefObject<HTMLElement | null>;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly state: ChannelSavedViewDialogState;
  readonly onClose: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onSubmit: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteMode = state.mode === "delete";
  const title = state.mode === "create"
    ? t("Save view")
    : state.mode === "rename"
      ? t("Rename saved view")
      : t("Delete saved view {name}?", { name: state.viewName });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!busy) onSubmit();
  }

  return (
    <Dialog
      busy={busy}
      dismissible
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-ui2-channel-saved-view-dialog={state.mode}
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (deleteMode ? cancelRef.current : inputRef.current)?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const returnTarget = returnFocusRef.current;
          if (returnTarget?.isConnected && !elementIsDisabled(returnTarget)) {
            returnTarget.focus({ preventScroll: true });
          } else {
            fallbackFocusRef.current?.focus({ preventScroll: true });
          }
        }}
      >
        {deleteMode ? (
          <>
            <DialogHeader
              closeLabel={t("Cancel")}
              description={t("This removes the saved view. Channel activity is not deleted.")}
              title={title}
            />
            {error ? (
              <DialogBody>
                <InlineFeedback tone="danger">{error}</InlineFeedback>
              </DialogBody>
            ) : null}
            <DialogFooter>
              <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                leadingIcon={<Trash2 aria-hidden="true" size={14} />}
                loading={busy}
                loadingLabel={t("Deleting...")}
                size="sm"
                variant="danger"
                onClick={onSubmit}
              >
                {t("Delete view")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader closeLabel={t("Cancel")} title={title} />
            <DialogBody>
              <Field label={t("Saved view name")}>
                <Input
                  ref={inputRef}
                  aria-label={t("Saved view name")}
                  disabled={busy}
                  maxLength={40}
                  value={state.draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                />
              </Field>
              {error ? <InlineFeedback tone="danger">{error}</InlineFeedback> : null}
            </DialogBody>
            <DialogFooter>
              <Button ref={cancelRef} disabled={busy} size="sm" variant="secondary" type="button" onClick={onClose}>
                {t("Cancel")}
              </Button>
              <Button
                leadingIcon={state.mode === "create"
                  ? <Save aria-hidden="true" size={14} />
                  : <PencilLine aria-hidden="true" size={14} />}
                loading={busy}
                loadingLabel={t("Saving...")}
                size="sm"
                type="submit"
                variant="primary"
              >
                {state.mode === "create" ? t("Save view") : t("Rename")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function elementIsDisabled(element: HTMLElement): boolean {
  return "disabled" in element && Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled);
}
