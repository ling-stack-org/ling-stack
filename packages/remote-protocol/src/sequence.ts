export type RemoteClientSequenceDecisionV1 =
  | { readonly kind: "accept"; readonly next: number }
  | { readonly kind: "close"; readonly expected: number; readonly received: number };

export function evaluateClientSequenceV1(lastAccepted: number, received: number): RemoteClientSequenceDecisionV1 {
  const expected = lastAccepted + 1;
  return received === expected
    ? { kind: "accept", next: received }
    : { kind: "close", expected, received };
}

export type RemoteServerSequenceDecisionV1 =
  | { readonly kind: "apply"; readonly next: number }
  | { readonly kind: "duplicate"; readonly current: number }
  | { readonly kind: "gap"; readonly expected: number; readonly received: number };

export function evaluateServerSequenceV1(lastApplied: number, received: number): RemoteServerSequenceDecisionV1 {
  if (received <= lastApplied) {
    return { kind: "duplicate", current: lastApplied };
  }
  if (received === lastApplied + 1) {
    return { kind: "apply", next: received };
  }
  return { kind: "gap", expected: lastApplied + 1, received };
}

export type RemoteAckDecisionV1 =
  | { readonly kind: "advance"; readonly next: number }
  | { readonly kind: "duplicate"; readonly current: number }
  | { readonly kind: "invalid"; readonly lastSent: number; readonly received: number };

export function evaluateCumulativeAckV1(
  lastAcknowledged: number,
  lastSent: number,
  received: number,
): RemoteAckDecisionV1 {
  if (received === lastAcknowledged) {
    return { kind: "duplicate", current: lastAcknowledged };
  }
  if (received > lastAcknowledged && received <= lastSent) {
    return { kind: "advance", next: received };
  }
  return { kind: "invalid", lastSent, received };
}
