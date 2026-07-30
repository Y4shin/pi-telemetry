# Task Changelog

## 2026-07-30 — pi-telemetry — Local-first observability for Pi workflows (pi-telemetry)

Built the full v1 Pi extension from scratch across 10 slices: SPEC §1 catalog captured into a shared `~/.pi/telemetry.db` (node:sqlite WAL, zero runtime deps) with buffered batch writes; `/tm` command surface with guarded read-only SQL and canned derived-metric queries; `query_telemetry` agent tool (7 presets); feedback collector (bus + `submit_feedback`); lineage foundation (env reader + bus listeners, lineage stamped on `sessions` per approved amendment). Concurrency soak validated the shared-DB design once (~50k rows/s, 0 busy errors), then retired per user decision in favour of a new `flush_log` write-load table; user-approved amendments also gave `telemetry_meta` an optional unconstrained `session_id` and full-jitter BUSY backoff. Final suite: 146 tests green, tsc clean; SPEC.md amended to match shipped reality.
