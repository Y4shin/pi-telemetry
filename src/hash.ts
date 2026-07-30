import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function textLength(text: string | null | undefined): number {
  if (text === null || text === undefined) return 0;
  return Buffer.byteLength(text, "utf8");
}
