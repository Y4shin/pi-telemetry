import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | undefined;
let cachedPiVersion: string | null | undefined;

export interface PackageInfo {
  name: string | null;
  version: string | null;
}

/**
 * Walk up from `startPath` looking for the nearest package.json.
 * Returns its `name` and `version`, or nulls when none is found or unreadable.
 */
export function resolvePackageInfo(startPath: string): PackageInfo {
  let dir = dirname(startPath);
  while (true) {
    const pkgPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      return { name: pkg.name ?? null, version: pkg.version ?? null };
    } catch {
      // Not found or unreadable: keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: null, version: null };
}

export function getExtensionVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const info = resolvePackageInfo(join(here, "..", "package.json"));
    cachedVersion = info.version ?? "0.0.0";
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
