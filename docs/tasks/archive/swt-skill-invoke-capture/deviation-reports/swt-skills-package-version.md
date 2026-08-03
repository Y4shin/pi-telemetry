## Deviation report — swt-skills-package-version

### API surface changes
- **Planned:** Extend `registerSkillCapture` in `src/capture/skills.ts` with a lazy `skillName → { source, version }` cache built from `pi.getCommands()` + a `package.json` walk-up from `sourceInfo.path`. Stamp `skill_source` + `skills_package_version` into the `session_events` payload via UPDATE (arch spec Q2: `json_set` or rebuild-payload) and project `skills_package_version` as a metadata row via `insertSkillMetadata`. Generalize `src/version.ts` walk pattern to an arbitrary path.
- **Actual:** All planned exports delivered. `resolvePackageInfo(startPath)` added to `src/version.ts` returning `{ name, version } | { null, null }`; `getExtensionVersion()` refactored to reuse it (no behavior change). `registerSkillCapture` extended with: lazy cache (`skillVersionCache: Map`), `getSkillPackageInfo()`, `enrichSkillInvokePayload()` using `json_set(payload, …, json_quote(?))`, and `insertSkillMetadata` projection. `resetSkillVersionCache()` exported for test isolation (additive, not specified). `resources_discover` handler added that unconditionally clears the cache.
- **Impact:** None on dependent slices. The `insertSkillMetadata` contract (slice 6) is used as specified. The `json_set` + `json_quote` enrichment mechanism preserves sibling payload keys for downstream slices (3, 4, 5) to add their own keys — exactly the arch-spec Q2 recommended approach. `resetSkillVersionCache()` is additive and only used in tests.

### Abstraction usage
- Used/was specified: **yes** — all specified abstractions were used:
  - `src/version.ts` `getExtensionVersion()` walk pattern: generalized as `resolvePackageInfo(startPath)`; `getExtensionVersion()` refactored to call it. Clean extraction, no duplication.
  - `pi.getCommands()` (ExtensionAPI): used to discover `source:"skill"` commands and their `sourceInfo.path`. Not assumed — resolved at runtime per findings §2.
  - `insertSkillMetadata` (slice 6): called to project `skills_package_version` as a `string`-typed metadata row. Correct usage.
  - `resources_discover` invalidation: handler registered, clears the cache.

### UPDATE-enrichment mechanism (Q2)
- **Planned:** Arch spec Q2 (approved) recommended slice 1 writes a minimal row; slices 2/3 issue `UPDATE` (`json_set` or rebuild-payload) so each slice is independently testable.
- **Actual:** Uses `UPDATE session_events SET payload = json_set(payload, '$.skill_source', json_quote(?), '$.skills_package_version', json_quote(?)) WHERE event_id = ?`. The `json_quote(?)` maps SQL NULL → JSON `null` and string → JSON string, so missing package info becomes explicit `null` in the payload without removing sibling keys from slice 1 (`skill_name`, `args_chars`, `args_hash`, `input_source`).
- **Assessment:** This is the testable, forward-compatible choice the arch spec allowed. It preserves the payload for downstream slices (3, 4, 5) to add their own keys via the same `json_set` mechanism. No deviation.

### Null-version edge case
- **Planned:** A skill with no enclosing `package.json` produces `skill_source:null, skills_package_version:null` (no crash, no meta error). A `package.json` with no `version` field produces `skills_package_version:null`.
- **Actual:** `resolvePackageInfo` walks up to the filesystem root and returns `{ name: null, version: null }` if no `package.json` is found. If `package.json` exists but lacks `version`, returns `{ name: pkg.name ?? null, version: null }`. If `package.json` is unreadable (invalid JSON), the `catch` block continues walking — but since the invalid `package.json` is the first match, it skips it and walks further up, potentially finding a *parent* `package.json`. **Minor observation:** this means an invalid `package.json` at one level is silently skipped in favor of a parent's, which is arguably more robust than failing, but differs slightly from "unreadable → null" if a parent package.json exists. The test "produces nulls when package.json is unreadable" passes because the test's temp dir has no parent `package.json`. No practical risk — in production, the skills package's `package.json` is valid.

### `resources_discover` invalidation scope
- **Planned (slice doc):** "`resources_discover` with `reason:"reload"` invalidates the cache; a subsequent invocation re-resolves."
- **Actual:** The handler clears the cache unconditionally on *any* `resources_discover` event (both `"startup"` and `"reload"`), not just `"reload"`.
- **Assessment:** This is a **wider invalidation than specified** but not a deviation that matters: clearing on `"startup"` is harmless (the cache is lazily rebuilt on next `input`), and clearing on `"reload"` is the specified behavior. The test only tests `"reload"`. No risk — wider invalidation is strictly more conservative. Noted for completeness.

### Out-of-scope changes
- `resetSkillVersionCache()` export: added for test isolation. Not specified but standard practice (mirrors the pattern of resetting module-level state in tests). Additive, no production impact.
- Local structural copies of `ResourcesDiscoverEvent` / `ResourcesDiscoverResult`: the Pi SDK does not re-export these from the package entry point, so the implementation keeps small local interfaces with a comment explaining why. This is a necessary adaptation, not a scope change. The types are structurally compatible with the SDK's actual event shape.

### Acceptance criteria check
| Criterion | Status | Notes |
|---|---|---|
| Package skill stamps `skill_source` + `skills_package_version` | ✅ | Test: "stamps skill_source and skills_package_version from package.json" |
| No enclosing `package.json` → nulls, no crash, no meta error | ✅ | Test: "produces nulls when skill has no enclosing package.json" |
| Version resolved from `getCommands()` `sourceInfo.path` | ✅ | `buildSkillVersionCache` uses `cmd.sourceInfo.path`; not hardcoded |
| Cache: second invocation does NOT re-read `package.json` | ✅ | Test: "caches package.json reads across repeated invocations" (mutates `package.json`, asserts stale version) |
| `resources_discover` reload invalidates + re-resolves | ✅ | Test: "invalidates cache on resources_discover reload and re-resolves" |
| `npm test` green, `tsc --noEmit` clean | ✅ | 186 tests pass, 0 fail; tsc clean |

### Task doc update needed?
No. No deviations require updating the task doc's Implementation notes. The implementation matches the arch spec and slice doc. The two minor observations (wider `resources_discover` invalidation; invalid-`package.json` walk-up behavior) are not material enough to record.

### User attention needed?
No. No API surface changes, no scope changes, no decisions requiring user judgment. The implementation faithfully follows the approved arch spec (Q1: state field, Q2: UPDATE enrichment, Q3: helper-wraps-guard, Q4: zero-dep).
