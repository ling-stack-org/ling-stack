import { createHash } from "node:crypto";

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
