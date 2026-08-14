---
kind: slice
slug: declare-error-parser
title: Parse the user error-classifier declaration from config (pattern map / function path)
task: ../task.md
mode: afk
status: todo
size: m
blocked_by: []
---

## End-to-end behavior

`loadConfig` parses the user's error-classifier declaration (grilling-chosen:
pattern map entries and/or a function module path) from env + settings,
defaulting to none (built-in classifier only). Invalid declarations fail safe
to none with a `telemetry_meta` note.

## Acceptance criteria

- [ ] `TelemetryConfig` gains the grilling-decided declaration field(s)
      (e.g. `errorClassifier: { patterns: [...], functionPath?: string }`).
- [ ] Parsed in `loadConfig` following the existing settings/env pattern;
      default is empty/none.
- [ ] Invalid declaration (bad pattern shape, unreadable function path) →
      falls back to none + a `telemetry_meta` `handler_error`-class note, no
      throw (SPEC §3 "telemetry must never break a session").
- [ ] `SPEC.md` §7 documents the declaration keys + trust note.
- [ ] Unit tests: valid pattern map parses; function path resolves; invalid
      declaration → none + meta note.

## Test plan

**Seam:** `test/config.test.ts`.
**Scenarios:** empty config → none; valid patterns → parsed; function path
      set → resolved; malformed patterns → none + meta; missing function file
      → none + meta.
**Edge cases:** pattern with regex-special chars (decide literal vs regex
      match per grilling); very large pattern list.

## Constraints and dependencies

- Grilling (`grill-pluggable-parser`) must settle the config surface +
      vocabulary before finalizing the field shapes.
- No schema change.
- Function loading is a trust boundary — document per SPEC §5 posture.
