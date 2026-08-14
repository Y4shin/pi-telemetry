# Reproduction — error_class always 'unknown' (classifier shape-blind)

## Symptom

`~/.pi/telemetry.db` `tool_executions.error_class` is non-null for 336 error
rows, but **every** value is the literal string `unknown`. None of the
`timeout` / `not_found` / `permission` / `validation` buckets ever appear,
despite a classifier that emits them.

## Investigation

### 1. Live DB confirms the symptom

```bash
python3 - <<'PY'
import sqlite3
con = sqlite3.connect("/home/pplattner/.pi/telemetry.db")
print("distinct non-null error_class:",
      list(con.execute("SELECT DISTINCT error_class FROM tool_executions WHERE error_class IS NOT NULL")))
print("is_error x error_class:",
      list(con.execute("SELECT is_error, error_class, COUNT(*) FROM tool_executions GROUP BY is_error, error_class")))
print("error_class on success rows:",
      con.execute("SELECT COUNT(*) FROM tool_executions WHERE error_class IS NOT NULL AND is_error=0").fetchone())
PY
# -> distinct non-null error_class: [('unknown',)]
# -> is_error x error_class: [(0, None, 7200), (1, 'unknown', 336)]
# -> error_class on success rows: (0,)
```

`is_error` is correct (336 errors, 0 on success); only classification is broken.

### 2. Root cause in source

`src/capture/tools.ts` `classifyError(err)` reads `err.message` / `err.code`:

```ts
function classifyError(err: unknown): ErrorClass {
  let message = "";
  let code: string | undefined;
  if (err instanceof Error) { message = err.message; code = err.code; }
  else if (typeof err === "string") { message = err; }
  else if (err !== null && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    message = typeof obj.message === "string" ? obj.message : "";
    code = typeof obj.code === "string" ? obj.code : undefined;
  }
  const combined = `${message} ${code ?? ""}`.toLowerCase();
  if (combined.includes("timeout") || ...) return "timeout";
  ...
  return "unknown";
}
```

Tool errors arrive from the Pi `tool_result` event as Anthropic-style
content-block envelopes — `{ content: [{ type: "text", text: "..." }] }` —
with **no** `message` or `code` field. Every real error hits the `else if
(typeof err === "object")` branch, finds `obj.message` absent → `message = ""`,
`code = undefined`, so `combined = " "`, and falls through to `return
"unknown"`.

`stageResult` → `computeResultMetrics` (same file) already extracts text from
`content` arrays via `hashContentBlocks`; the classifier does not reuse it.

### 3. The fix (slice: `fix-classifier-envelope`)

Make `classifyError` read error text from the shapes tool errors actually
arrive in:

- a bare string error → use it directly (already handled).
- an Anthropic content-block envelope `{ content: [{ type: "text", text }] }`
  → extract text from the content blocks (reuse `hashContentBlocks` /
  `isTextBlock`, or a shared extractor), concatenate text from all text
  blocks, then run the substring matchers on that.
- keep the `{ message, code }` Error-like object path for safety.
- envelope with no `content` array (e.g. `{ error: "x" }`) → `unknown`, no
  throw.
- `message` present AND `content` present → prefer `content` (the actual
  tool-error shape), fall back to `message` if `content` has no text.

Keep the 5-bucket set (`timeout | not_found | permission | validation |
unknown`) and substring matchers unchanged.

### 4. Regression test (the test rule)

In `test/tools.test.ts`, feed `classifyError` (export it, or drive via the
`tool_result` capture path) representative envelopes and assert the expected
bucket:

- `{ content: [{ type: "text", text: "Command timed out" }] }` → `timeout`
  (RED before fix: `unknown`; GREEN after: `timeout`)
- `{ content: [{ type: "text", text: "ENOENT: no such file" }] }` → `not_found`
- `{ content: [{ type: "text", text: "EACCES: permission denied" }] }` →
  `permission`
- `{ content: [{ type: "text", text: "invalid argument" }] }` → `validation`
- an unrecognized envelope → `unknown`
- bare string of each phrase → same bucket
- `null` / `undefined` input → `unknown` (no throw)
- envelope with no `content` array → `unknown` (no throw)
- envelope with multiple content blocks → concatenate text from all text
  blocks before matching

The RED signal: feed `{ content: [{ type:"text", text:"EBADF: no such file" }]
}` → before the fix it returns `unknown`; after, `not_found`.

## Verdict

Real bug — a shape mismatch in the error classifier. It is invoked on every
error but cannot read the payload, so every error lands on `unknown`. One
slice fixes the shape; forward-only (historical `unknown` rows stay, since no
raw text was stored to reclassify from).
