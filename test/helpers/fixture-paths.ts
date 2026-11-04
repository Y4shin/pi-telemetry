import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Platform-neutral fixture paths.
 *
 * Fixtures must not hardcode POSIX absolute paths: resolving one on Windows
 * produces a drive-rooted path, so a row that stores a resolved value no longer
 * equals the literal the test wrote. Building the paths with
 * `join(tmpdir(), …)` keeps them absolute on every platform without touching
 * the filesystem — nothing here creates a directory.
 */
export const FIXTURE_ROOT = join(tmpdir(), "pi-telemetry-fixtures");

/** Default working directory for captured sessions. */
export const FIXTURE_CWD = join(FIXTURE_ROOT, "proj");

/** A second, distinct working directory, used to prove a capture is ignored. */
export const FIXTURE_OTHER_CWD = join(FIXTURE_ROOT, "other");

/** Working directory of the seeded root session in `fixture-db.ts`. */
export const FIXTURE_ROOT_SESSION_CWD = join(FIXTURE_ROOT, "root");

/** Working directory of the seeded child session in `fixture-db.ts`. */
export const FIXTURE_CHILD_SESSION_CWD = join(FIXTURE_ROOT, "child");

/** A tool-argument path, used where only identity and JSON length matter. */
export const FIXTURE_TOOL_PATH = join(FIXTURE_ROOT, "foo");

/** A second tool-argument path, distinct from {@link FIXTURE_TOOL_PATH}. */
export const FIXTURE_TOOL_PATH_ALT = join(FIXTURE_ROOT, "bar");
