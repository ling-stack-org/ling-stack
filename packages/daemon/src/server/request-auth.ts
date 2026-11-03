import { timingSafeEqual } from "node:crypto";

/** HTTP requests and WebSocket upgrades share the same configured credential boundary. */
export function daemonRequestIsAuthorized(authToken: string | undefined, authorization: unknown): boolean {
  if (!authToken) return true;
  if (typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${authToken}`, "utf8");
  const provided = Buffer.from(authorization, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
