import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;
let cachedPiVersion: string | null | undefined;

export function getExtensionVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    cachedVersion = pkg.version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function getPiVersion(): string | null {
  if (cachedPiVersion !== undefined) return cachedPiVersion;
  try {
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const pkgPath = join(dirname(fileURLToPath(mainUrl)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedPiVersion = pkg.version ?? null;
  } catch {
    cachedPiVersion = null;
  }
  return cachedPiVersion;
}
