import { isDeviceObservationV1 } from "./device.js";

export function observationsMatchDeviceReceipt(
  observations: unknown, observationIds: readonly string[], targetDeviceId: string,
): boolean {
  if (observations === undefined) return true;
  if (!Array.isArray(observations)) return false;
  const references = new Set(observationIds);
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!isDeviceObservationV1(observation) || observation.subjectId !== targetDeviceId
      || !references.has(observation.id) || seen.has(observation.id)) return false;
    seen.add(observation.id);
  }
  return true;
}
