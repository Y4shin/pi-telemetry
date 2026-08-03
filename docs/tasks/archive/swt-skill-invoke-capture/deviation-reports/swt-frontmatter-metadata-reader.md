## Deviation report — swt-frontmatter-metadata-reader

### API surface changes
- **Planned:** Extend `registerSkillCapture` in `src/capture/skills.ts` to
  re-read the invoked skill's `SKILL.md` from `sourceInfo.path`, parse YAML
  frontmatter, extract `metadata.telemetry.capture` (comma/space-delimited
  arg identifiers), and project each captured slug as a typed
  `session_event_metadata` row via `insertSkillMetadata`. Zero-dep
  frontmatter extractor (arch spec Q3: `yaml` NOT a repo dep; do NOT add it).
- **Actual:** Matches the planned surface. `registerSkillCapture` now calls
  `projectCapturedFields()` which uses `readSkillFrontmatterCapture()` (a
  zero-dep `---\n…\n---` regex extractor + indent-stack YAML key-path parser)
  to find `metadata.telemetry.capture`, `parseSkillArgs()` for
  positional/named arg extraction, and `insertSkillMetadata` for typed
  projection. No new exports beyond `registerSkillCapture` and
  `resetSkillVersionCache` (the latter from slice 2, reused for cache
  invalidation). No new public API surface added by this slice.
- **Impact:** None on dependent slices. Slice 4 (`telemetry_skill_context`
  tool) and slice 5 (`turn_start` back-fill) are unaffected — they call
  `insertSkillMetadata` and `t.state.lastSkillInvokeEventId` which this
  slice does not change.

### Abstraction usage
- **`insertSkillMetadata` (slice 6):** Used correctly. Each captured slug
  is projected via `insertSkillMetadata(t, eventId, key, "string", value)`.
  The helper's self-guarding (arch spec Q4) is respected — callers do not
  wrap it in `guard()`.
- **`resources_discover` cache invalidation:** Used correctly. The
  `skillInfoCache` (shared with slice 2's version resolution) is set to
  `null` on `resources_discover` with `reason: "reload"`, forcing a lazy
  rebuild on the next `input`. Tested explicitly
  (`test/capture/skills.test.ts` "invalidates frontmatter cache on
  resources_discover reload" — writes a new `capture` key, fires reload,
  asserts the next invocation picks up the new keys).
- **`guard()` (state.ts):** The `input` and `resources_discover` handlers
  are wrapped in `guard()` as in slices 1–2.
- **`json_set` UPDATE (arch spec Q2):** Used correctly. Captured fields are
  written into the JSON payload via
  `UPDATE session_events SET payload = json_set(payload, ?, json_quote(?))
  WHERE event_id = ?`, matching the approved enrichment mechanism.

### Zero-dep frontmatter extractor (arch spec Q3)
- **CONFIRMED: NO `yaml` dependency added.** `package.json` `dependencies`
  is `{}` and `devDependencies` is unchanged (no `yaml` entry). The
  extractor is a ~40-line zero-dep parser: a regex
  (`/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/m`) to isolate the frontmatter
  block, then an indent-stack line parser that tracks the dotted key path
  (`metadata.telemetry.capture`) and splits the value by comma/space or
  YAML array form. This satisfies the arch spec Q3 resolution and the
  SPEC zero-runtime-deps contract.

### Privacy (slugs only)
- **Spec:** "Only kebab-case slug identifiers are recorded; if a captured
  arg is not a clean slug, store its length/hash instead of the raw text
  (privacy posture)."
- **Actual — DEVIATION:** Non-slug captured values are stored as **JSON
  `null`** in the payload with **no metadata row** — NOT as length/hash.
  The implementation checks `isKebabSlug(raw)` and if it fails, sets
  `value = null`, writes `json_set(payload, '$.key', null)`, and skips
  `insertSkillMetadata`. The test "skips non-slug captured values and
  stores a JSON null" confirms: the payload field is `null`, no metadata
  row exists, and the raw text does NOT leak into any table.
- **Assessment:** This is a **simplification**, not a privacy regression.
  The raw arg is never stored (the test asserts `value_text LIKE
  '%not_a_slug%'` returns 0 rows). The spec's "length/hash" fallback would
  add marginal fingerprinting value, but the existing `args_chars` +
  `args_hash` from slice 1 already fingerprints the entire args string.
  Storing per-field length/hash for non-slug captured values would be
  redundant with that. The deviation is defensible but should be noted for
  the coherence-refactor review.

### Out-of-scope changes
- **Named-arg syntax:** The slice doc says "positional or named" without
  specifying syntax. The implementation supports `--key=value`,
  `-key=value`, `key=value`, and `--key value` (space-separated). This is
  an additive interpretation of an underspecified requirement, not a scope
  change. No test asserts named-arg extraction specifically (only
  positional capture is tested), so this is untested behavior.
- **`parseFrontmatterCapture` YAML array form:** The parser handles
  `capture: [target, map]` (YAML array) in addition to the comma/space
  form. Additive, not specified but reasonable.
- **Metadata key naming:** The slice-acceptance example says
  `capture: "task"` produces `target:"pi-telemetry"`, but the
  implementation uses the capture identifier itself as the key
  (`capture: "target"` → key `target`). The test uses `capture: target`
  (not `capture: task`), so it passes. This is consistent with the general
  rule ("extract those values from the parsed args into … `target`,
  `map`, `slice`, etc.") — the example in the slice doc appears to be a
  naming inconsistency, not a spec violation.

### Task doc update needed?
Yes — append to `## Implementation notes`:
- Slice 3 uses a zero-dep frontmatter extractor (no `yaml` dep added).
- Non-slug captured values → JSON `null` + no metadata row (simplified
  from the spec's length/hash fallback; `args_chars`/`args_hash` from slice
  1 covers the raw fingerprint).
- Named-arg syntax (`--key=value`, `key=value`, `--key value`) is
  implemented but not tested; positional capture is the tested path.

### User attention needed?
No. The non-slug deviation (null vs length/hash) is a simplification that
does not regress privacy (raw text is never stored) and is covered by the
existing `args_chars`/`args_hash` fingerprint. The named-arg syntax is
additive and untested but not harmful. Neither requires a user decision;
both should be noted in the coherence-refactor review.
