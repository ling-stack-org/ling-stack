import type { LingServerInstallationV1, LingServerPeerBindingV1, LingServerRouteAttemptV1 } from "@ling-stack/contracts";
import { DeviceFabricError } from "./device-fabric.js";

export class LingServerPeerRegistry {
  readonly #installations = new Map<string, LingServerInstallationV1>();
  readonly #bindings = new Map<string, LingServerPeerBindingV1>();
  readonly #routes = new Map<string, LingServerRouteAttemptV1>();

  registerInstallation(installation: LingServerInstallationV1): LingServerInstallationV1 {
    const current = this.#installations.get(installation.installationId);
    if (current && installation.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "Ling Server installation revision must advance");
    if (!/^https:\/\//u.test(installation.serverOrigin)) throw new DeviceFabricError("invalid_graph", "Ling Server origin must use HTTPS");
    this.#installations.set(installation.installationId, installation);
    return installation;
  }

  bindPeers(binding: LingServerPeerBindingV1): LingServerPeerBindingV1 {
    const installation = this.#installations.get(binding.installationId);
    if (!installation || installation.status !== "active") throw new DeviceFabricError("target_missing", "Ling Server installation is unavailable");
    const current = this.#bindings.get(binding.bindingId);
    if (current && binding.revision <= current.revision) throw new DeviceFabricError("revision_conflict", "peer binding revision must advance");
    if (binding.status === "active" && [...this.#bindings.values()].some(item => item.bindingId !== binding.bindingId && item.gatewayId === binding.gatewayId && item.status === "active")) throw new DeviceFabricError("revision_conflict", "gateway already has an active peer binding");
    this.#bindings.set(binding.bindingId, binding);
    return binding;
  }

  revokeBinding(bindingId: string, revision: number): LingServerPeerBindingV1 {
    const binding = this.#bindings.get(bindingId);
    if (!binding) throw new DeviceFabricError("target_missing", "peer binding is missing");
    const revoked = { ...binding, status: "revoked" as const, epoch: binding.epoch + 1, revision };
    this.#bindings.set(bindingId, revoked);
    return revoked;
  }

  beginRoute(route: LingServerRouteAttemptV1): LingServerRouteAttemptV1 {
    const binding = this.#bindings.get(route.bindingId);
    if (!binding || binding.status !== "active") throw new DeviceFabricError("safety_denied", "route requires an active peer binding");
    this.#routes.set(route.routeAttemptId, route);
    return route;
  }

  selectRoute(routeAttemptId: string, selected: "lan" | "direct" | "relay", now: string): LingServerRouteAttemptV1 {
    const route = this.#routes.get(routeAttemptId);
    if (!route) throw new DeviceFabricError("target_missing", "route attempt is missing");
    if (Date.parse(route.expiresAt) <= Date.parse(now)) throw new DeviceFabricError("safety_denied", "route attempt has expired");
    const next = { ...route, selected, status: "connected" as const };
    this.#routes.set(routeAttemptId, next);
    return next;
  }

  failoverRoute(routeAttemptId: string, now: string): LingServerRouteAttemptV1 {
    const route = this.#routes.get(routeAttemptId);
    if (!route) throw new DeviceFabricError("target_missing", "route attempt is missing");
    if (Date.parse(route.expiresAt) <= Date.parse(now)) return { ...route, status: "expired" };
    if (route.selected === "lan" || route.selected === "direct" || !route.selected) return { ...route, preferred: "relay", status: "checking" };
    return { ...route, status: "failed" };
  }
}
