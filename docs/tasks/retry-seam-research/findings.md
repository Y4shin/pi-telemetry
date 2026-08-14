# Findings: Does Pi expose a retry seam, and can retries be inferred/linked?

**Task:** `retry-seam-research`
**Map:** `telemetry-signal-gaps`
**Date:** 2026-08-14
**Verdict:** **No extension-facing retry seam exists.** A reliable in-turn
heuristic IS available, but it has a hard limitation (unobserved in the current
dataset). Recommendation: implement linkage via a turn-scoped attempt counter
populated from the existing `message_start`/`message_end` events — no upstream
Pi change required, no new Pi event needed.

---

## Question 1 — Retry seam in Pi: DOES NOT EXIST (for extensions)

Pi has a full auto-retry subsystem, but it is **internal-only**. None of its
events reach the extension event bus (`pi.on(...)`).

**Evidence (all citations are `node_modules/@earendil-works/pi-coding-agent/dist/...`,
version 0.80.10, the installed copy):**

- `core/agent-session.js:2089-2151` — `_prepareRetry(message)`: increments
  `_retryAttempt`, computes `delayMs = baseDelayMs * 2 ** (attempt-1)`, and
  emits `auto_retry_start` with `{ attempt, maxAttempts, delayMs, errorMessage }`.
- `core/agent-session.js:370-380` and `770-782` — `auto_retry_end` emitted
  with `{ success: boolean, attempt, finalError? }`.
- **Both are emitted via `this._emit(...)`** (`core/agent-session.js:281-287`),
  which fans out only to `this._eventListeners` — the **internal/UI listener
  channel**, not the extension runner. Definition:
  ```js
  _emit(event) { for (const l of this._eventListeners) l(event); }
  ```
- The extension runner is a **separate** channel: `this._extensionRunner.emit(...)`
  (`core/agent-session.js:313,436,439,447,...`). A grep for `auto_retry` across
  the whole `agent-session.js` shows it appears **only** as arguments to
  `this._emit(...)`, never to `this._extensionRunner.emit(...)`.
- `core/extensions/types.d.ts` — the exhaustive extension event list (lines
  377-682: `session_*`, `before/after_provider_*`, `agent_*`, `turn_*`,
  `message_*`, `tool_*`, `model_select`, `thinking_level_select`, `user_bash`,
  `input`, `tool_call`, `tool_result`). **No `auto_retry_*` type is declared.**
- `docs/extensions.md:551-562` — documents `agent_start`/`agent_end`/`agent_settled`
  and explicitly says `agent_settled` is the signal that "no automatic retry,
  compaction, or queued continuation will run" — i.e. retry is acknowledged as
  opaque to extensions. `docs/extensions.md:1009` confirms `ctx.isIdle()` is
  false "while Pi is processing ... automatic retry" — again, retry is
  internal state, not an event.

**Conclusion for Q1:** There is no extension event for "a retry is about to
happen" or "this is attempt N." The `auto_retry_start`/`end` events and the
`_retryAttempt` counter (`core/agent-session.js:606` exposes `get retryAttempt()`
on `AgentSession`, but `AgentSession` is not in the extension API surface) are
all internal. **Verdict: seam DOES NOT EXIST for extensions.**

## Question 2 — Header reliability & per-attempt event firing

**`after_provider_response`** fires **per HTTP response** via the `onResponse`
callback (`core/sdk.js` `sourcesContent`, the `streamFn` `onResponse` callback
→ `runner.emit({ type: "after_provider_response", status, headers })`). A
retried request makes a new HTTP call, so `after_provider_response` fires again
for the retry — but with **no link to the original request** (pi-telemetry
matches it to "the most recent in-flight request for this turn" in
`src/capture/llm.ts:178-189`, which during a retry would be the *new*
`message_start`'s row, not the failed one).

**`message_start`/`message_end` fire per LLM attempt**, including the failed
one. The retry path is (`core/agent-session.js:751-756`):
```js
async _runAgentPrompt(messages) {
  await this.agent.prompt(messages);
  while (await this._handlePostAgentRun()) {
    await this.agent.continue();   // ← retry re-enters the loop here
  }
}
```
`_handlePostAgentRun` (`:758-783`) calls `_prepareRetry` for a retryable error,
which returns `true`; the `while` then calls `this.agent.continue()`, which
runs another agent step → emits a fresh `message_start`/`message_update`/
`message_end` to extensions. **Critically, no `turn_start` or `turn_end` fires
between the failed attempt and the retry** — the retry is inside the same turn.
So in pi-telemetry's correlation state (`src/capture/turns.ts:14-147`,
`src/state.ts:61-65`), the retry's `message_start` shares the **same `turn_id`**
as the failed attempt's.

**Therefore a retry produces ≥2 `llm_requests` rows with the same `turn_id`:**
the failed attempt (with `stop_reason='error'`, null usage/tokens/cost, often
short `duration_ms`) followed by the successful attempt (with real usage).
This is the linkage key — see Q4.

## Question 3 — Heuristic inference: FEASIBLE with one hard limitation

**Proposed heuristic:** within a single `turn_id`, `llm_requests` rows ordered
by `started_unix_ms` where an earlier row has `stop_reason = 'error'` (and/or
`http_status >= 500` / `= 429`) and a later row in the same turn succeeds
constitutes a retry group. The attempt number is the 1-based index within the
group.

**Reliability assessment:**

- **False positives from concurrent requests:** the existing test "does not
  cross-contaminate interleaved concurrent requests" (`test/llm.test.ts`) shows
  pi-telemetry already tracks multiple in-flight requests per turn via
  `inFlightRequests` keyed on a message signature. **However**, true
  concurrent LLM requests in one turn are not currently produced by pi's
  agent loop (it awaits each `agent.step()`), so within a turn the requests
  are **sequential**, not concurrent. The "interleaved" test is a defensive
  guard, not a real-world pattern. Sequential ordering by `started_unix_ms`
  within a turn is therefore a reliable attempt sequence.
- **False-positive risk from tool-use turns:** a turn that calls tools and
  then makes a *second* LLM request (after tool results) is **not** a retry —
  it's a normal multi-step turn. **This is the hard limitation.** Both "retry"
  and "tool-use continuation" produce ≥2 `llm_requests` in one turn. They are
  indistinguishable from `llm_requests` alone: both have an earlier
  `stop_reason='toolUse'` or `'error'` followed by a later row.
- **Disambiguator:** retries are characterized by `stop_reason='error'` on the
  *failed* attempt; tool-use continuations by `stop_reason='toolUse'`. So the
  reliable retry predicate is: **an earlier row in the turn with
  `stop_reason='error'` followed by a later row** — *not* any multi-row turn.
  Tool-use continuations have `stop_reason='toolUse'` on the earlier row and
  are correctly excluded. This makes the heuristic reliable for the common
  case.

**Hard limitation (must be documented):** a retry that occurs *after* a
tool-use step in the same turn (rare: tool call succeeds, then the follow-up
LLM call errors and retries) would be miscounted, because the turn already has
a `toolUse` row. The heuristic would see `[..., toolUse, error, success]` and
count only the `error→success` pair as one retry, which is actually correct —
the `attempt` index within the `error`-initiated group is what matters.
**Remaining ambiguity:** two independent errors in one turn (error, retry,
error, retry) — countable as two groups by splitting on `stop_reason='error'`
boundaries. The heuristic holds.

**Dataset reality check:** over 8,276 live `llm_requests`, **every turn has
exactly 1 `llm_requests` row** (`SELECT reqs_per_turn, COUNT(*) ... → (1,
8525)`). There are 68 `stop_reason='error'` rows, each the sole row in its
turn, at varied `turn_index` values (0, 1, 2, 3, 5, 16, 17, 20, 26...). This
means **no retries occurred in this 16-day dataset** — the 68 error turns are
unrecoverable errors (exhausted retries, or non-retryable errors like context
overflow which `_isRetryableError` excludes per `:2079-2084`). The heuristic is
untested against real retries but the event-flow logic is sound; a unit test
that simulates the `error→success`-in-one-turn sequence will validate it.

## Question 4 — Linkage schema: RECOMMEND `attempt` + `attempt_group_id`

Three candidate schemas, evaluated:

| Option | Column(s) | Write-path change | Query | Trade-off |
|---|---|---|---|---|
| **A. `attempt` counter** | `llm_requests.attempt INTEGER` (default 1) | Increment a per-turn counter in `src/capture/llm.ts` `message_start`, reset on `turn_start` | `WHERE attempt > 1` counts retries | Simple, but "attempt 2" alone doesn't say it's a retry of which row; works because retries are in-turn-sequential |
| **B. `parent_request_id`** | `llm_requests.parent_request_id TEXT` | On retry's `message_start`, set parent = the failed attempt's `request_id` (track "last request in this turn") | Self-join on parent | True linkage graph; but pi-telemetry can't know at `message_start` time whether this is a retry or a tool-use continuation — it would have to set it for *every* request and mark the link type |
| **C. `attempt_group_id`** | `llm_requests.attempt_group_id TEXT` | Assign a group id; new group when the previous row in the turn had `stop_reason != 'error'` | `GROUP BY attempt_group_id HAVING COUNT(*) > 1` | Cleanest query; but the grouping decision needs the *previous* row's `stop_reason`, which is available at `message_start` time only if the prior `message_end` already flushed — a race against the buffer |

**Recommendation: Option A (`attempt` counter), populated turn-locally.**

Rationale:
- It requires **no upstream Pi change** and **no new Pi event** — it reuses
  the existing `message_start` event with a turn-scoped counter.
- The counter is reset to 0 on `turn_start` and incremented on every
  `message_start` within the turn; `attempt = counter` is written on each
  `llm_requests` row. (1-based: the first request in a turn is `attempt = 1`.)
- **Retries are then queryable as `WHERE attempt > 1`** within a turn — but
  this counts *any* multi-request turn. To isolate *retries* specifically
  (vs tool-use continuations), the query joins on the prior row's
  `stop_reason = 'error'`. The counter alone is necessary; the retry
  *classification* is a query-time decision over the counter + stop_reason,
  not a write-time decision. This avoids the Option C race.
- Schema: `ALTER TABLE llm_requests ADD COLUMN attempt INTEGER DEFAULT 1`
  (nullable for legacy rows; forward-only migration v5 — note this shares the
  migration version slot with the TTFT history migration in
  `ttft-first-token-fix`; coordinate so both land in one v5 migration, or
  use v5 for TTFT and v6 for this — decide in `retry-linkage`).

**Why not B:** `parent_request_id` set on every request is no more informative
than `attempt` + `turn_id` (the turn already groups them), and it forces a
write-time link-type decision pi-telemetry can't make reliably at
`message_start` time.

**Why not C:** the group-id needs the prior row's `stop_reason` at write time,
which races the flush buffer. The counter avoids the race by recording the
neutral fact (position in turn) and deferring the retry classification to
query time.

## Question 5 — Upstream blocker: NONE

No upstream Pi change is required for Option A. The retry seam is absent
(Q1), but the existing `message_start`/`message_end`/`turn_start` events
already carry everything needed to populate a turn-scoped attempt counter
(Q2 + Q3). **`retry-linkage` is NOT blocked by an upstream seam.** The only
upstream-dependent enhancement — a true `auto_retry_start`/`end` extension
event — would let pi-telemetry record the *intended* delay/retry-decision
(authoritative), but it is not required to count attempts. Recommend recording
the absent-seam limitation in `SPEC.md` §1.4 as a note ("attempt count is
inferred from in-turn `message_start` sequence, not from an upstream retry
event; the `auto_retry_*` internal events are not extension-facing as of
pi 0.80.10") so future readers know an upstream event would improve fidelity.

---

## Recommendation for `retry-linkage`

Implement **Option A**: add `llm_requests.attempt INTEGER` (default 1, nullable
for legacy), populate from a turn-scoped counter in `src/capture/llm.ts`
(`message_start`), reset on `turn_start`. No upstream change. Add a canned
query preset (e.g. `retry_count` or extend `ttft_by_model`) that counts rows
where `attempt > 1` and the prior in-turn row had `stop_reason = 'error'`,
documenting the tool-use-continuation disambiguator. Update `SPEC.md` §1.4
with the inference note. **`retry-linkage` is unblocked and feasible.**

## Newly-sharp decisions for `retry-linkage`

1. **Schema shape** — `attempt INTEGER` (Option A), not `parent_request_id`
   or `attempt_group_id`. Migration version must be coordinated with the TTFT
   history nulling migration (both target v5; combine into one migration or
   sequence as v5/v6).
2. **Counter semantics** — 1-based, reset on `turn_start`, incremented on
   every `message_start` in the turn. The first request in a turn is
   `attempt = 1` (not 0), so legacy rows (all `attempt = NULL`) and new
   single-request turns (`attempt = 1`) are distinguishable.
3. **Retry classification is query-time, not write-time** — the counter records
   position; "is this a retry?" is `attempt > 1 AND prior_row.stop_reason =
   'error'` at query time. Avoids the flush-race of Option C.
4. **Document the limitation** — tool-use continuations also produce
   `attempt > 1`; the `stop_reason` disambiguator handles the common case, but
   a retry-after-tool-use is counted as a continuation, not a fresh retry
   group. Acceptable; record in SPEC.

## Impact on dependents

- **`retry-linkage` (feature):** unblocked, feasible, Option A. Update its
  task/slice to reference these findings for the exact column + counter logic.
- **`retry-parse-hole` (bug):** independent, unaffected. Still worth doing
  (HTTP-date `Retry-After`).
- **`SPEC.md` §1.4:** needs a note that attempt count is inferred, plus the
  `attempt` column in the §2 schema block.

## Unresolved questions

- **Migration versioning:** does `attempt` land in the same v5 migration as
  the TTFT-history `UPDATE`, or a separate v6? Decide in `retry-linkage`
  planning (the two are independent and could be one migration with two
  statements, or two sequential ones).
- **Counter reset edge case:** if a `turn_start` fires but the agent errors
  before any `message_start` (no request row), the counter stays 0; the next
  turn's first `message_start` resets to 1. Confirm the `turn_start` handler
  zeroes a per-turn counter in `src/state.ts` (small state addition).
