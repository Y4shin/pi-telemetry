# Reproduction — bash_executions table never populated

## Symptom

`~/.pi/telemetry.db` `bash_executions` table has **0 rows** while
`tool_executions` records 731 `bash` tool calls. Originally flagged as a
collection gap.

## Investigation

### 1. Live DB confirms the symptom

```
bash_executions:            0
tool_executions WHERE bash: 731   (across ext 0.1.0 and 0.2.0)
```

No `handler_error` entries mention bash in `telemetry_meta`, so the bash
capture handler is not throwing inside `guard`.

### 2. The collector is verified working (L1)

`test/bash.test.ts` fires `user_bash` and asserts a `bash_executions` row is
written for: successful command, failing exit code, `!!` exclude_from_context,
truncated output, rethrow-on-error, and abort cancellation.

```bash
cd /home/pplattner/Projects/pi-telemetry
node --test test/bash.test.ts
# -> 6/6 pass
```

So when `user_bash` fires, `bash_executions` IS populated correctly. The
collector is functional.

### 3. What `user_bash` actually captures (SDK trace)

`registerBashCapture` (`src/capture/bash.ts`) listens to `pi.on("user_bash")`
and returns wrapped `BashOperations`; recording happens inside
`wrappedOps.exec`.

Where is `user_bash` emitted in the SDK?

```
node_modules/.../modes/interactive/interactive-mode.js:4951
  handleBashCommand(): await extensionRunner.emitUserBash({...})
  ... this.session.executeBash(command, chunk, { operations: eventResult?.operations })
```

`emitUserBash` is called from exactly **one** site: `handleBashCommand` — the
**user-typed `!`/`!!` bash command** path in interactive mode. `executeBash`
then runs the wrapped operations, which call `recordBashExecution`.

The **agent's `bash` tool** (`createBashToolDefinition.execute`) calls
`ops.exec` directly and emits `tool_execution_start` / `tool_result` /
`tool_execution_end` — captured in `tool_executions` — but it **never emits
`user_bash`** and never routes through `handleBashCommand`.

### 4. SPEC confirms the intended scope

`SPEC.md` §1.6:

> ### 1.6 User bash (`!` / `!!`)
> Source: `user_bash`, wrapping `createLocalBashOperations()` to time
> execution.

So `bash_executions` is **by design** scoped to user-typed `!`/`!!` commands.
Agent bash tool calls are captured in `tool_executions` (generic tool table),
not `bash_executions`. SPEC line 480 also reserves a `capture.bashCommand`
flag (currently false) for future full-command capture.

## Verdict

**Not a bug — working as designed.** The empty table reflects that no
user-typed `!`/`!!` bash commands were issued in the captured sessions; the
user delegated all bash work to the agent (731 agent tool calls, correctly in
`tool_executions`). The collector is green (6/6 tests).

## If richer agent-bash metrics are desired

Capturing `exit_code` / `command_hash` / `cwd` / `cancelled` / `truncated` /
`output_chars` for **agent** bash tool calls (not just user-typed) would be a
**feature request**, not a bug fix — the `user_bash` event does not fire for
agent tool calls, so a different capture hook (e.g., `tool_execution_*` for
`tool_name === "bash"`) would be needed. Route via refine-idea / create-task.
