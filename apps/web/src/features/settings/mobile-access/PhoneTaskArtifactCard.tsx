import type { RemoteDeviceArtifactOfferV1, RemoteDeviceCollaborationViewV1 } from "@ling-stack/contracts";
import { useEffect, useRef, useState } from "react";
import type { DesktopMobileAccessCapabilities } from "../../../../../desktop/shared/desktop-capabilities.js";
import { useI18n } from "../../../i18n.js";
import { Button, InlineFeedback } from "../../../shared/ui/index.js";

export function PhoneTaskArtifactCard({ access, share }: {
  readonly access: Pick<DesktopMobileAccessCapabilities, "listDeviceArtifacts" | "offerDeviceArtifact">;
  readonly share: Extract<RemoteDeviceCollaborationViewV1, { state: "active" }>;
}) {
  const { t } = useI18n();
  const [offers, setOffers] = useState<readonly RemoteDeviceArtifactOfferV1[]>([]);
  const [offering, setOffering] = useState(false);
  const [error, setError] = useState(false);
  const uploading = useRef(false);
  const refreshVersion = useRef(0);

  useEffect(() => {
    const requestVersion = ++refreshVersion.current;
    void access.listDeviceArtifacts({ shareId: share.shareId, expectedRevision: share.revision }).then(next => {
      if (requestVersion === refreshVersion.current) {
        setOffers(next);
        setError(false);
      }
    }).catch(() => {
      if (requestVersion === refreshVersion.current) setError(true);
    });
  }, [access, share]);

  async function offerArtifact() {
    if (uploading.current) return;
    uploading.current = true;
    setOffering(true);
    setError(false);
    try {
      const offer = await access.offerDeviceArtifact({
        shareId: share.shareId, expectedRevision: share.revision, proposalId: `phone_artifact_${crypto.randomUUID()}`,
      });
      if (offer) {
        refreshVersion.current += 1;
        setOffers(previous => [...previous.filter(item => item.manifest.proposalId !== offer.manifest.proposalId), offer]);
      }
    } catch {
      setError(true);
    } finally {
      uploading.current = false;
      setOffering(false);
    }
  }

  return <>
    {offers.length ? <ul className="mobile-access-analysis-notes">
      {offers.map(offer => <li key={offer.manifest.proposalId}>
        {offer.manifest.name} <span>{offer.receipt ? t("File verified by phone") : offer.status === "accepted"
          ? t("Waiting for file verification") : offer.status === "rejected" ? t("Rejected") : t("Awaiting phone review")}</span>
      </li>)}
    </ul> : null}
    {error ? <InlineFeedback tone="danger">{t("Device files could not be shared or read.")}</InlineFeedback> : null}
    <div className="mobile-access-actions">
      <Button type="button" variant="secondary" loading={offering} onClick={() => void offerArtifact()}>{t("Share a PC file")}</Button>
    </div>
  </>;
}
