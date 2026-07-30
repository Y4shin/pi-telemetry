# Session-shape events capture — implementation result

Slice `session-events-capture` for task `pi-telemetry` is complete on branch `slice/session-events-capture`.

## What changed

- `src/capture/session-events.ts` — new handler module exporting `registerSessionEventsCapture(pi, t)`.
  - Maps `session_before_compact` / `session_compact` → `compaction`
  - Maps `model_select` → `model_change`
  - Maps `thinking_level_select` → `thinking_change`
  - Maps `session_before_fork` → `branch`
  - Maps `session_tree` → `tree_nav`
  - Each row gets a UUID `event_id`, the current `session_id`, `unix_ms = t.now()`, a JSON `payload`, and the mapped `type`.
  - Payloads are built only from documented event fields; absent / null fields are omitted, never fabricated.
  - JSON serialization failure is caught, logged to `telemetry_meta`, and the handler continues with an empty payload object.
- `src/capture/index.ts` — re-exports `registerSessionEventsCapture`.
- `index.ts` — registers the new handler in the extension entry.
- `test/session-events.test.ts` — 11 new L1 unit tests covering all five event types, missing-field omission, no-session skip, same-leaf tree nav, and `unix_ms` ordering.

## Divergence from plan

1. **`from_extension` on `session_before_compact`:** the slice doc lists `from_extension` as part of the `compaction` payload for both `session_before_compact` and `session_compact`. The installed Pi type `SessionBeforeCompactEvent` does not expose a `fromExtension` field (it cannot be known before compaction runs), so `from_extension` is emitted only for `session_compact`. This follows the spec rule that absent fields are omitted, not fabricated.
2. **`model_change` payload shape:** the slice doc says "from→to model, source". To remain useful for cross-provider telemetry queries, the payload uses `from`/`to` objects containing `{ provider, id }` rather than bare model id strings. The `source` field is emitted exactly as documented.
3. **`session_before_tree` not handled:** it is outside the slice doc's listed event types and is intentionally left for future work.

## Validation

- `node --test test/session-events.test.ts` — 11/11 passing.
- `npm test` — full suite 35/35 passing.
- `npm run check` — `tsc --noEmit` clean.

## Notable events

- Top-level `@earendil-works/pi-coding-agent` does not export `ModelSelectEvent` / `ThinkingLevelSelectEvent`, so the handler uses contextual typing from the `pi.on` overloads rather than explicit type annotations.
- Pre-existing `.pi-subagents/artifacts` churn and `docs/tasks/state.yaml` modifications were left unstaged; only slice-relevant files were committed.

## Acceptance report