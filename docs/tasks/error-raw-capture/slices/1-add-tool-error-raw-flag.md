---
kind: slice
slug: add-tool-error-raw-flag
title: Add the capture.toolErrorRaw config flag (default off) with privacy warning
task: ../task.md
mode: afk
status: todo
size: s
blocked_by: []
---

## End-to-end behavior

A new `capture.toolErrorRaw` boolean (final name from grilling) is parsed
from env + settings, defaults off, and triggers the existing one-time privacy
warning when enabled. No capture behavior yet (next slice).

## Acceptance criteria

- [ ] `CaptureConfig` in `src/config.ts` gains the new flag; `DEFAULTS`,
      env (`PI_TELEMETRY_CAPTURE_TOOL_ERROR_RAW` or grilling-determined), and
      settings.json parsing follow the existing `toolArgs`/`toolResults`
      pattern.
- [ ] `SPEC.md` §7 config table documents the flag + default.
- [ ] Enabling emits the one-time warning the content flags use.
- [ ] Default config → flag is `false` (unit test in `config.test.ts`).

## Test plan

**Seam:** `test/config.test.ts` (env/settings/default parsing).
**Scenarios:** default off; env `=1` on; settings block on; env overrides
      settings off. Warning fires once when on.
**Edge cases:** invalid value → falls back to default false.

## Constraints and dependencies

- Grilling (`grill-error-raw-capture`) must have settled the flag name and
  warning behavior before this slice's exact strings are finalized; the
  slice body uses a placeholder name until then.
- No schema change.
