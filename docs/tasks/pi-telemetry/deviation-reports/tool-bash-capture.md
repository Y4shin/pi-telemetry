# Deviation report — tool-bash-capture

Reviewed: `git diff task/pi-telemetry..slice/tool-bash-capture` (8 files,
+948/−4), `src/capture/tools.ts`, `src/capture/bash.ts`, tests. Suite: 68/68
pass, `tsc --noEmit` clean (verified independently).

## API surface changes

- **Planned (arch spec):** exports `registerToolCapture(pi, t)` and
  `registerBashCapture(pi, t)`; consumes `correlation()`, `timers`,
  `sha256()`, `config.capture` flags; bounded `error_class` set
  `timeout|not_found|permission|validation|unknown`.
- **Actual:** exactly those two exports with the spec'd signatures; the
  `error_class` tokens match the arch spec verbatim (the slice doc's prose
  example "not-found" with hyphen is superseded by the normative arch-spec
  `not_found` — non-issue). One shared-harness widening: L1 stub `fire()`
  now returns `Promise<R | undefined>` (was `Promise<void>`) so value-
  returning events (`user_bash`) can be exercised in L1. Additive and
  backward-compatible — existing tests ignore the return value.
- **Impact on dependent slices:** none. tm-command-surface and
  query-telemetry-tool read only tables, not these exports. The `fire()`
  widening is available to future L1 tests (e.g. lineage env-export helper)
  but nothing must change. No arch-spec edits needed for pending slices.

## Abstraction usage

- **Used as specified:** `createLocalBashOperations()` (no manual process
  spawning), `t.state.timers` with `"tool:"` prefix, `t.state.correlation()`,
  module-scope in-flight maps, `node:crypto` for hashing, `node:test` harness,
  L2 via SDK `createAgentSession()` + `fauxToolCall` scripted tool call.
- **Partially deviated:** the spec'd shared `sha256()` from `src/hash.ts` is
  used by `bash.ts` but **not** by `tools.ts`, which inlines `createHash`
  calls. Partially justified — result hashing streams content blocks through
  incremental `hasher.update()`, which the string-only `sha256()` helper
  can't express. `textLength()` is now duplicated verbatim between
  `tools.ts` and `bash.ts`. **Coherence-refactor candidate** (bin the
  duplication, e.g. a shared `sha256Stream`/`textLength` in `src/hash.ts`);
  no behavior impact.

## Out-of-scope changes

- `test/helpers/l1-stub.ts`: `fire()` signature widening (see above) —
  justified, additive, declared by the implementer.
- No other additions or removals.

## Acceptance criteria check

| Criterion | Result |
|---|---|
| Exactly one row per completed tool call | ✅ `completedToolCallIds` dedup; tested with duplicate `tool_execution_end` and `tool_result`+`end` interleave (count=1) |
| Bounded `error_class`, never raw messages | ✅ `classifyError()` emits enum tokens only; raw text inspected but never stored; test asserts single-token values |
| SHA-256 stability | ✅ pinned-hash tests, incl. hash-of-empty |
| Zero content under default flags | ✅ `args_json`/`result_text` asserted NULL in L1 and in the real SDK L2 row |
| Flags-enabled population | ✅ tested with both flags on |
| Bash wrapper preserves original behavior | ✅ delegates to `createLocalBashOperations()`, forwards options (incl. `signal`/`onData`), rethrows exec errors after recording a best-effort row; success/failure/cancel/truncate/throw all covered |
| Orphan end → no crash, single consistent row | ✅ best-effort row with `duration_ms NULL`, `args_chars=0` (note: llm.ts *drops* orphans instead — both satisfy their respective slice docs; consistency nuance for the coherence refactor, not an error) |

## Residual observations (non-blocking; coherence-refactor items)

1. `completedToolCallIds` grows unboundedly for the process lifetime (every
   `tool_call_id` ever seen is retained). Consider clearing at a session or
   agent-run boundary.
2. `InFlightTool` captures `sessionId`/`runId`/`turnId` at start, but the
   INSERT uses fresh `correlation()` — the stored ids are dead data. Either
   use the captured ids (more correct under cross-turn dropped-event edge
   cases) or remove them from the struct.
3. Bash `output_chars` counts raw bytes; other `*_chars` columns count UTF-8
   bytes of text — consistent in practice but worth aligning/naming when the
   duplicated `textLength` is consolidated (declared by the implementer).
4. Bash `truncated` is inferred from raw byte/line counts vs
   `DEFAULT_MAX_BYTES`/`DEFAULT_MAX_LINES`, an approximation of pi's actual
   sanitized-text truncation (declared by the implementer; output is bounded
   by pi's rolling buffer so the flag is reliable).

## Task doc update needed?

Yes — small append to `## Implementation notes`:
"Slice 4 widened the L1 harness: `L1Stub.fire()` returns the fired handler's
result (`Promise<R | undefined>`) so value-returning events such as
`user_bash` are testable in L1. Backward-compatible." (Also worth noting the
two coherence candidates above for the step-3 refactor.)

## User attention needed?

No — no scope change, no production API surface differences affecting
dependents; remaining items are cleanliness items for the step-3 coherence
refactor.
