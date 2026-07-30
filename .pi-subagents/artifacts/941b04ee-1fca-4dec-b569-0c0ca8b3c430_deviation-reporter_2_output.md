## Deviation report — session-events-capture

### API surface changes
- **Planned:** `registerSessionEventsCapture(pi, t): void` (arch spec slice 5), raw SQL inserts into `session_events` with dropped absent fields.
- **Actual:** exactly that signature, re-exported via `src/capture/index.ts` and registered in `index.ts`. No code-level API divergence.
- **Data-contract divergence (payload shape):** `model_change` payload uses `from`/`to` **objects** `{provider, id}` instead of bare model-id strings implied by slice doc / SPEC §1.7 ("from→to model"). Rationale given: cross-provider queries. This changes what SQL users and any future consumers (e.g. `/tm` output, user queries on `json_extract(payload,'$.from')`) see — a string where prose implied, now a nested object. `source` emitted as documented.
- **Impact on dependent slices:** none in code — no slice (8 canned SQL per SPEC §1, or 9 presets) consumes `session_events` payload keys programmatically. Impact is only on the published data contract for external SQL users.

### Abstraction usage
- Used as specified: **yes.** `Telemetry.enqueue`/`state.sessionId`/`now`/`guard`/`meta`; `randomUUID` from `node:crypto` (SPEC §1 UUID ids); real `DatabaseSync` in tests (no mocked DB); L1 stub harness. Nothing from the do-not-reimplement list was reimplemented.
- Field names verified against installed pi types (`dist/core/extensions/types.d.ts`, v0.80.10): `preparation.tokensBefore`, `compactionEntry.tokensBefore`, `fromExtension`, `previousModel`, `source`, `previousLevel`, `entryId`/`position`, `oldLeafId`/`newLeafId` — all correct, not invented.

### Out-of-scope changes
- `from_extension` emitted only for `session_compact` rows, not `session_before_compact` — verified correct: `SessionBeforeCompactEvent` has no `fromExtension` field. Spec-conform ("absent fields omitted, not fabricated"), slice-doc wording was over-precise.
- `tree_nav` rows additionally carry `entry_id` (from `summaryEntry.id`) — slight addition, built from a documented event field; acceptable.
- No `session_before_tree` handler — correctly out of scope (not in the slice doc's event list).

### Divergence from acceptance criteria
- One row per event type with documented keys: **met** (5 types, per-type unit tests).
- Valid JSON, absent fields omitted not fabricated: **met** (`cleanPayload` drops null/undefined; verified tests).
- Rows carry `session_id` + `unix_ms` for ordering: **met** (ordering test asserts increasing `unix_ms`).
- Failure modes: JSON-serialization failure → meta note + handler continues with `{}` payload: **met**; event with no active session → row skipped silently (no meta note; acceptable under SPEC §3 ownership rule).

Validation: `npm test` 35/35 pass (11 new for this slice), `npm run check` (tsc) clean.

### Task doc update needed?
**Yes** — append to `## Implementation notes`:
- `model_change` payload shape is `{from: {provider, id} | omitted, to: {provider, id}, source}` (objects, not bare ids) — affects any future docs for `/tm export` consumers and SPEC §1.7 wording.
- `from_extension` appears only on post-compaction rows (`session_compact`), never on `session_before_compact` rows (field does not exist pre-compaction).

### User attention needed?
**No.** No code-level API surface change, no scope change. The only nuance is the richer `model_change` payload shape, which is internal data shape, additive vs. ambiguous doc prose, and has no dependent-slice impact. Recorded here and proposed for the task doc's implementation notes.