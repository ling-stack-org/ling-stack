import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChannelMessageFileRef } from "@ling-stack/contracts";
import { useI18n } from "../../../i18n.js";
import { Button, InlineFeedback, Textarea } from "../../ui/index.js";
import { acknowledgeReviewDraft, readReviewDraft, reviewDraftKey, reviewStorage, upsertReviewDraft } from "./review-draft.js";
import "./review.css";

export interface ReviewDraftController {
  readonly refs: readonly ChannelMessageFileRef[];
  readonly owner: string;
  readonly error: string;
  readonly hasEmptyComments: boolean;
  readonly isCurrent: () => boolean;
  readonly save: (ref: ChannelMessageFileRef) => boolean;
  readonly remove: (id: string) => void;
  readonly acknowledge: (snapshot: readonly ChannelMessageFileRef[], owner: string) => void;
  readonly attachImage?: (file: File) => Promise<void>;
}
export const ReviewDraftContext = createContext<ReviewDraftController | undefined>(undefined);
export function useReviewDraft(): ReviewDraftController | undefined { return useContext(ReviewDraftContext); }
export function useReviewDraftController(owner: string, attachImage?: (file: File) => Promise<void>): ReviewDraftController {
  const [state, setState] = useState(() => ({ owner, refs: readReviewDraft(reviewStorage(), owner), error: "" }));
  const live = useRef(state);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const activeState = state.owner === owner ? state : { owner, refs: readReviewDraft(reviewStorage(), owner), error: "" };
  useEffect(() => {
    if (state.owner !== owner) setState(activeState);
  }, [activeState, owner, state.owner]);
  live.current = activeState;
  function change(update: (refs: readonly ChannelMessageFileRef[]) => readonly ChannelMessageFileRef[]): boolean {
    if (!mounted.current || live.current.owner !== owner) return false;
    try {
      const refs = update(live.current.refs);
      let error = "";
      try { const storage = reviewStorage(); if (!storage) throw new Error("Storage unavailable"); storage.setItem(reviewDraftKey(owner), JSON.stringify(refs)); }
      catch { error = "Review draft could not be saved on this device."; }
      const next = { owner, refs, error }; live.current = next; setState(next);
      return true;
    } catch (reason) { setState(current => ({ ...current, error: reason instanceof Error ? reason.message : String(reason) })); return false; }
  }
  return { ...activeState, attachImage, hasEmptyComments: activeState.refs.some(ref => !ref.annotation?.text.trim()),
    isCurrent: () => mounted.current && live.current.owner === owner,
    save: ref => change(refs => upsertReviewDraft(refs, ref)),
    remove: id => change(refs => refs.filter(ref => ref.annotation?.id !== id)),
    acknowledge: (snapshot, expectedOwner) => {
      if (mounted.current && live.current.owner === expectedOwner) {
        const refs = acknowledgeReviewDraft(live.current.refs, snapshot);
        let error = "";
        try { const storage = reviewStorage(); if (!storage) throw new Error("Storage unavailable"); storage.setItem(reviewDraftKey(expectedOwner), JSON.stringify(refs)); }
        catch { error = "Review draft could not be saved on this device."; }
        const next = { owner: expectedOwner, refs, error }; live.current = next; setState(next);
      } else {
        const storage = reviewStorage();
        try { storage?.setItem(reviewDraftKey(expectedOwner), JSON.stringify(acknowledgeReviewDraft(readReviewDraft(storage, expectedOwner), snapshot))); }
        catch { /* The detached owner's persisted draft remains available for recovery. */ }
      }
    } };
}

export function ReviewDraftShelf({ onSend, disabled = false }: { readonly onSend: () => void | Promise<void>; readonly disabled?: boolean }): React.JSX.Element | null {
  const review = useReviewDraft();
  const { t } = useI18n();
  if (!review || !review.refs.length && !review.error) return null;
  return <section className="review-draft-shelf" aria-label={t("Review feedback")}>
    <header><strong>{t("Review feedback")} · {review.refs.length}</strong><Button size="sm" disabled={disabled || !review.refs.length || review.hasEmptyComments} onClick={() => void onSend()}>{t("Send feedback")}</Button></header>
    {review.error ? <InlineFeedback tone="danger">{t(review.error)}</InlineFeedback> : null}
    {review.hasEmptyComments ? <InlineFeedback tone="danger">{t("Add text to every review comment before sending.")}</InlineFeedback> : null}
    <div className="review-draft-list">{review.refs.map(ref => <article key={ref.annotation!.id}>
      <header><small>{ref.path}{ref.line ? `:${ref.annotation?.kind === "code" && ref.annotation.startLine ? `${ref.annotation.startLine}-` : ""}${ref.line}` : ""}</small><Button size="sm" variant="ghost" disabled={disabled} onClick={() => review.remove(ref.annotation!.id)}>{t("Remove")}</Button></header>
      <Textarea aria-label={t("Review comment")} value={ref.annotation!.text} maxLength={8000} disabled={disabled} rows={2} onChange={event => {
        review.save({ ...ref, annotation: { ...ref.annotation!, text: event.target.value } });
      }} />
    </article>)}</div>
  </section>;
}
