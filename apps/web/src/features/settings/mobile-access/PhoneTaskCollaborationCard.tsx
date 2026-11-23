import {
  REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES,
  type RemoteDeviceAnalysisInputV1,
  type RemoteDeviceCollaborationViewV1,
} from "@ling-stack/contracts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DesktopMobileAccessCapabilities } from "../../../../../desktop/shared/desktop-capabilities.js";
import { useI18n } from "../../../i18n.js";
import { Button, Field, InlineFeedback, Textarea } from "../../../shared/ui/index.js";
import { PhoneTaskArtifactCard } from "./PhoneTaskArtifactCard.js";

type Access = Pick<DesktopMobileAccessCapabilities, "listDeviceCollaboration" | "proposeDeviceAnalysis" | "draftDeviceAnalysis"
  | "listDeviceArtifacts" | "offerDeviceArtifact" | "listDeviceBuildArtifacts" | "offerDeviceBuildArtifact">;
type ActiveShare = Extract<RemoteDeviceCollaborationViewV1, { state: "active" }>;

export function PhoneTaskCollaborationCard({ access, canDraft, canShareArtifacts, canShareBuilds }: {
  readonly access: Access; readonly canDraft: boolean; readonly canShareArtifacts: boolean; readonly canShareBuilds: boolean;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const [shares, setShares] = useState<readonly ActiveShare[]>([]);
  const [error, setError] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await access.listDeviceCollaboration();
      if (version !== requestVersion.current) return;
      setShares(next.filter(share => share.state === "active"));
      setError(false);
    } catch {
      if (version !== requestVersion.current) return;
      setShares([]);
      setError(true);
    }
  }, [access]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(interval);
      requestVersion.current += 1;
    };
  }, [refresh]);

  return <section className="mobile-access-card" aria-labelledby={headingId}>
    <header className="mobile-access-section-header"><h2 id={headingId}>{t("Phone device tasks")}</h2></header>
    {error ? <InlineFeedback tone="danger">{t("Shared device tasks could not be loaded.")}</InlineFeedback> : null}
    {!error && shares.length === 0 ? <p>{t("Share a device diagnosis from the paired phone to ask this PC for help.")}</p> : null}
    {shares.map(share => <SharedPhoneTask key={share.shareId} share={share} access={access} canDraft={canDraft}
      canShareArtifacts={canShareArtifacts} canShareBuilds={canShareBuilds} refresh={refresh} />)}
  </section>;
}

function SharedPhoneTask({ share, access, canDraft, canShareArtifacts, canShareBuilds, refresh }: {
  readonly share: ActiveShare;
  readonly access: Access;
  readonly canDraft: boolean;
  readonly canShareArtifacts: boolean;
  readonly canShareBuilds: boolean;
  readonly refresh: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [draft, setDraft] = useState({ text: "", revision: share.revision, modelLabel: "" });
  const [working, setWorking] = useState<"draft" | "send">();
  const [error, setError] = useState<string>();
  const retry = useRef<RemoteDeviceAnalysisInputV1 | undefined>(undefined);
  const inFlight = useRef(false);
  const { projection } = share;
  const { facts } = projection;
  const stale = Boolean(draft.text) && draft.revision !== share.revision;
  const taskStatusLabels: Record<typeof projection.status, string> = {
    created: t("Waiting"), target_resolved: t("Waiting"), capabilities_loaded: t("Waiting"),
    planning: t("Running"), awaiting_approval: t("Pending approval"), executing: t("Running"),
    verifying: t("Verification pending"), succeeded: t("Completed"), partial: t("Partially completed"),
    failed: t("Failed"), cancelled: t("Cancelled"), unknown: t("Verification pending"),
  };
  const verificationStatus = projection.attempt.verification?.status;
  async function generateDraft(): Promise<void> {
    if (inFlight.current || !canDraft) return;
    inFlight.current = true;
    setWorking("draft");
    setError(undefined);
    try {
      const generated = await access.draftDeviceAnalysis({ shareId: share.shareId, expectedRevision: share.revision, locale });
      if (generated.shareId !== share.shareId || generated.expectedRevision !== share.revision) {
        throw new Error(t("Review your note against the updated diagnosis."));
      }
      setDraft({ text: generated.text, revision: generated.expectedRevision, modelLabel: generated.modelLabel });
    } catch {
      setError(t("The workspace chat model could not prepare a note."));
      await refresh();
    } finally {
      inFlight.current = false;
      setWorking(undefined);
    }
  }

  async function propose(): Promise<void> {
    const { text, revision } = draft;
    if (inFlight.current || stale || !text.trim()) return;
    const previous = retry.current;
    const request = previous?.text === text && previous.expectedRevision === revision
      ? previous
      : { shareId: share.shareId, expectedRevision: revision, proposalId: `phone_note_${crypto.randomUUID()}`, text };
    retry.current = request;
    inFlight.current = true;
    setWorking("send");
    setError(undefined);
    try {
      await access.proposeDeviceAnalysis(request);
      retry.current = undefined;
      setDraft({ text: "", revision, modelLabel: "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The note could not be sent."));
    } finally {
      await refresh();
      inFlight.current = false;
      setWorking(undefined);
    }
  }
  const yesNo = (value: boolean | undefined) => value === undefined ? "—" : value ? t("Yes") : t("No");
  return <article className="mobile-access-collaboration-task">
    <dl className="mobile-access-details">
      <div><dt>{t("Task")}</dt><dd>{projection.taskId}</dd></div>
      <div><dt>{t("Target")}</dt><dd>{projection.targetDeviceId}</dd></div>
      <div><dt>{t("Task status")}</dt><dd>{taskStatusLabels[projection.status]}</dd></div>
      <div><dt>{t("Expires at")}</dt><dd>{new Date(share.expiresAt).toLocaleTimeString()}</dd></div>
      {verificationStatus ? <div><dt>{t("Device verification")}</dt><dd>{verificationStatus === "verified" ? t("Verified")
        : verificationStatus === "failed" ? t("Failed") : t("Verification pending")}</dd></div> : null}
      {facts?.kind === "home_assistant" ? <>
        <div><dt>{t("Availability")}</dt><dd>{facts.availability === "available" ? t("Available") : t("Unavailable")}</dd></div>
        {facts.automationEnabled !== undefined ? <div><dt>{t("Automation enabled")}</dt><dd>{yesNo(facts.automationEnabled)}</dd></div> : null}
      </> : null}
      {facts?.kind === "linux_network" ? <>
        <div><dt>{t("Network connected")}</dt><dd>{yesNo(facts.network.connected)}</dd></div>
        <div><dt>{t("Route available")}</dt><dd>{yesNo(facts.network.routeAvailable)}</dd></div>
        <div><dt>{t("Wi-Fi associated")}</dt><dd>{yesNo(facts.network.wifiAssociated)}</dd></div>
        <div><dt>{t("DNS resolution")}</dt><dd>{yesNo(facts.network.dnsNameResolved)}</dd></div>
        {facts.network.linkError ? <div><dt>{t("Wi-Fi diagnosis")}</dt><dd>{facts.network.linkError}</dd></div> : null}
      </> : null}
    </dl>
    {share.proposals.length ? <ul className="mobile-access-analysis-notes">
      {share.proposals.map(proposal => (
        <li key={proposal.proposalId}>{proposal.text} <span>{proposal.status === "accepted" ? t("Accepted")
          : proposal.status === "rejected" ? t("Rejected") : t("Awaiting phone review")}</span></li>
      ))}
    </ul> : null}
    <form className="mobile-access-collaboration-task" onSubmit={event => { event.preventDefault(); void propose(); }}>
      <Field label={t("Analysis for the phone")} error={error ?? (stale ? t("Review your note against the updated diagnosis.") : undefined)}
        description={draft.modelLabel ? t("Drafted with {model}", { model: draft.modelLabel }) : undefined}>
        <Textarea rows={3} value={draft.text} disabled={working !== undefined} maxLength={REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES}
          onChange={event => setDraft({ ...draft, text: event.target.value, revision: share.revision })} />
      </Field>
      <div className="mobile-access-actions">
        {canDraft ? <Button type="button" variant="secondary" disabled={working === "send"}
          loading={working === "draft"} onClick={() => void generateDraft()}>{t("Draft with workspace model")}</Button> : null}
        <Button type="submit" variant="primary" disabled={working === "draft" || stale || !draft.text.trim()
          || new TextEncoder().encode(draft.text.trim()).length > REMOTE_DEVICE_COLLABORATION_MAX_NOTE_BYTES}
          loading={working === "send"}>{t("Send analysis")}</Button>
      </div>
    </form>
    {canShareArtifacts ? <PhoneTaskArtifactCard key={share.revision} access={access} share={share} canShareBuilds={canShareBuilds} /> : null}
  </article>;
}
