## Deviation report — capture-error-envelopes

### API surface changes
- **Planned:** `StagedResult` extended with `rawResultText: string | null` carrying the raw envelope (`safeJsonStringify(result)`), set in `computeResultMetrics`/`stageResult` where the original `event.content`/`event.result` is in scope. `insertToolExecution` writes `result_text` using the precedence: `capture.toolErrorRaw && staged.isError` → `staged.rawResultText`; else `capture.toolResults` → `staged.resultText`; else `NULL`. Reuses the existing `result_text` column — no migration.
- **Actual:** Exactly as planned. `StagedResult.rawResultText: string | null` added (tools.ts:26). `computeResultMetrics` sets `rawResultText: safeJsonStringify(result)` (tools.ts:198) — captures the raw JSON of the entire `result` object (which is `event.content`/`event.result`) at stage time. `insertToolExecution` implements the exact precedence specified (tools.ts:233-240): `captureErrorRaw && staged?.isError ? staged?.rawResultText ?? null : captureResults ? staged?.resultText ?? null : null`. The old `captureResults ? staged?.resultText ?? null : null` line is replaced by the new precedence chain.
- **Impact:** None on dependent slices. No downstream slice in this task or the map consumes `rawResultText`. The `grill-pluggable-parser` task will query `result_text` (the stored output), not `rawResultText` (the in-memory field), so the internal interface is self-contained.

### Abstraction usage
- **`safeJsonStringify`:** ✅ Used — `computeResultMetrics` calls `safeJsonStringify(result)` to produce `rawResultText` (tools.ts:198). Matches the arch spec's "reuse to serialize the envelope" directive.
- **`stageResult`/`insertToolExecution` split:** ✅ Used — the raw envelope is captured at stage time (where `result` is in scope) and carried in `StagedResult`, since `insertToolExecution` lacks the original event object. Exactly as the arch spec's interface contract specified.
- **`result_text` column reuse:** ✅ Used — no new column, no migration. The existing `result_text` in the INSERT (14th value) now receives the precedence-resolved `resultText` variable.
- **`computeResultMetrics` extracted-text path:** ✅ Preserved — the existing `resultText` field (extracted text for `toolResults`) is unchanged; `rawResultText` is a separate, parallel field. Matches the arch spec's "Do NOT reimplement: the existing extracted text path stays for `toolResults`".

### Out-of-scope changes
- **LLM error bodies:** ✅ Not added — no `llm_requests.error_body` column, no LLM-scope changes. Matches grilling decision (tool errors only).
- **Extracted/normalized text for `toolErrorRaw`:** ✅ Not done — `toolErrorRaw` writes `rawResultText` (raw JSON), not the extracted `resultText`. Matches grilling decision (raw-as-is).
- **Success-row capture:** ✅ Not done — the precedence chain gates on `staged?.isError`; success rows with `toolErrorRaw` on still get `NULL` (falls through to the `captureResults` check, which is off). Matches the slice doc.
- **Schema changes:** ✅ None — no migration, no new column, no DDL change.
- **Cap policy:** Decided in-slice as **no cap** (tools.ts:227-230 comment). The arch spec left this undecided (grilling Fog). The implementer chose no cap with documented rationale: tool error envelopes are protocol-bounded, the flag is opt-in, and capping would corrupt JSON. If a cap is needed later, `feedbackMaxBytes` is the suggested default. This is a reasonable in-slice decision that stays within the arch spec's allowance ("decide in-slice, document").

### Divergence from slice doc acceptance criteria

| Criterion | Status | Notes |
|---|---|---|
| `result_text` for error rows when flag on, raw-as-is JSON | ✅ Met | `rawResultText = safeJsonStringify(result)` stored; test asserts `result_text === JSON.stringify(errorEnvelope)` |
| Success rows: `result_text` stays `NULL` even with flag on | ✅ Met | Precedence gates on `staged?.isError`; test asserts `null` for `is_error=0` with flag on |
| Flag off: no `result_text` written | ✅ Met | Precedence falls to `captureResults` (off) → `null`; test asserts `null` for error rows with flag off |
| Unit test: flag on + error → raw JSON; flag on + success → NULL; flag off → NULL | ✅ Met | 6 tests added covering all three plus multi-block, non-text-block, no-content-array, and `tool_result` path |
| Privacy regression: default config zero non-null `result_text` | ✅ Met | `test/privacy.test.ts` passed unmodified; suite 252/252 green |

### Task doc update needed?
**Yes — append to `## Implementation notes`:** The task doc's Implementation notes section covers slice 1 but not slice 2. Add a note: "**capture-error-envelopes** (slice 2/2): Extended `StagedResult` with `rawResultText: string \| null` (raw JSON of the result object, captured via `safeJsonStringify` in `computeResultMetrics`). `insertToolExecution` writes `result_text` with the precedence `toolErrorRaw && isError → rawResultText`, else `toolResults → resultText`, else `NULL`. Cap policy decided in-slice as no cap (documented in code comment). 6 tests added; full suite 252/252 green, tsc clean."

### User attention needed?
**No.** No scope changed, no API surfaces differ from the spec, no out-of-scope work was added. The cap-policy decision is the only in-slice judgment call, and it stays within the arch spec's allowance.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Only modified src/capture/tools.ts (16 lines) and test/tools.test.ts (160 lines); no schema/migration changes, no LLM scope, no new columns, no success-row capture, no extracted-text path for toolErrorRaw. Cap policy decided in-slice as no-cap (within arch spec allowance, documented in code comment)."
    }
  ],
  "changedFiles": [
    "src/capture/tools.ts",
    "test/tools.test.ts",
    "docs/tasks/error-raw-capture/slices/2-capture-error-envelopes.md"
  ],
  "testsAddedOrUpdated": [
    "test/tools.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "252 tests pass, 0 fail, 34 suites"
    },
    {
      "command": "git diff main..HEAD --stat",
      "result": "passed",
      "summary": "3 files changed, 196 insertions, 16 deletions — all within scope"
    }
  ],
  "validationOutput": [
    "StagedResult.rawResultText added at tools.ts:26, set in computeResultMetrics via safeJsonStringify(result) at tools.ts:198",
    "Precedence chain at tools.ts:233-240: captureErrorRaw && isError → rawResultText; else captureResults → resultText; else null",
    "6 new tests: raw envelope on error, NULL on success, NULL when off, multi-block, no-content-array, tool_result path",
    "privacy.test.ts unmodified and passing (default config → zero non-null result_text)"
  ],
  "residualRisks": [
    "no-cap policy: unbounded raw error envelopes could be large for tools with verbose error output; mitigated by opt-in flag and protocol-bounded envelopes; revisit if feedbackMaxBytes reuse is needed later"
  ],
  "noStagedFiles": true,
  "diffSummary": "Extended StagedResult with rawResultText (raw JSON via safeJsonStringify), added precedence chain in insertToolExecution (toolErrorRaw && isError → raw, else toolResults → extracted, else null), 6 new unit tests, no-cap policy documented in comment",
  "reviewFindings": [
    "no blockers: implementation matches arch spec and slice doc exactly; only in-slice judgment was the no-cap policy, within spec allowance"
  ],
  "manualNotes": "Task doc Implementation notes section covers slice 1 but not slice 2 — should append a slice-2 note when landing. Cap policy: no cap, documented in code comment at tools.ts:227-230."
}
```
