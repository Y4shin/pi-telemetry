# Findings — SWT research seams

Task: `swt-research-seams` (type: research)
Map: `skill-workflow-telemetry`
Investigated: 2026-08-03, against Pi v0.80.10 (`@earendil-works/pi-coding-agent`
installed types) + the installed task-workflow skills package (v2.5.1 at
`~/.pi/agent/git/github.com/Y4shin/skills`).

> **Naming correction up front.** The prior idea doc
> (`docs/ideas/skill-invocation-capture.md`) hypothesized a `user_input` event.
> The real event is named **`input`** (`pi.on("input", …)`; SDK type
> `InputEvent`). There is no `user_input` event in Pi v0.80.10. Every reference
> below uses the correct name.

---

## Question 1 — Skill invocations: which event, which paths, what payload

### Answer

**The `input` event is the capture seam.** It fires when user input is
received, *after* extension commands are checked but *before* skill and
template expansion — so it sees the raw `/skill:<name> <args>` text.

**Verified payload** — `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:617`:

```typescript
export type InputSource = "interactive" | "rpc" | "extension";   // line 615
export interface InputEvent {                                    // line 617
    type: "input";
    text: string;            // raw input, "/skill:foo bar" NOT yet expanded
    images?: ImageContent[];
    source: InputSource;     // "interactive" (TUI) | "rpc" (API) | "extension" (sendUserMessage)
    streamingBehavior?: "steer" | "followUp";   // undefined when idle
}
export type InputEventResult =                                   // line 629
    | { action: "continue" }                 // pass through (default)
    | { action: "transform"; text: string; images?: ImageContent[] }
    | { action: "handled" };                 // skip agent entirely
```

Registration: `pi.on("input", handler)` — `ExtensionAPI.on` overload at
`types.d.ts:872`. Docs: `extensions.md:878`.

**Path coverage (verified in SDK source, not just docs):**

| Path | Reaches `session.prompt()`? | Fires `input`? | `event.source` |
|---|---|---|---|
| TUI (typed) | yes → `prompt()` `agent-session.js:816` | **yes** | `"interactive"` |
| RPC (`/rpc`) | yes → `rpc-mode.js:302` `session.prompt(..., {source:"rpc"})` | **yes** | `"rpc"` |
| Print (`pi -p`) | yes → `print-mode.js:95,98` `session.prompt(...)` | **yes** | `"interactive"` (default) |
| Extension-injected (`sendUserMessage`) | yes | **yes** | `"extension"` |
| **Mid-stream `steer()`** | no — `agent-session.js:995` calls `_expandSkillCommand` directly, **no `emitInput`** | **NO** ⚠️ | n/a |
| **Mid-stream `followUp()`** | same path as steer | **NO** ⚠️ | n/a |

`emitInput` is the single chokepoint (`agent-session.js:817`), guarded by
`hasHandlers("input")`. Expansion happens *after* it (`agent-session.js:830`
`_expandSkillCommand`). So the `input` handler sees `/skill:foo bar` as raw
text, before the skill body is spliced in.

**⚠️ Gap: mid-stream skill steering bypasses `input`.** `steer()` and
`followUp()` (`agent-session.js:994`, `~1011`) expand skill commands *without*
emitting `input`. A `/skill:` invoked while the agent is streaming will not be
captured by an `input`-only handler. This is a real but narrow path (skills
are usually invoked when idle). **Decision for grilling:** accept the gap and
document it, or also hook a second seam (see §"Alternative seams rejected"
below).

**Parsing the skill name + args from `event.text`.** Pi's own parser is
trivial (`agent-session.js:956`):

```js
if (!text.startsWith("/skill:")) return;       // not a skill invocation
const spaceIndex = text.indexOf(" ");
const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
const args      = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
```

pi-telemetry should mirror this parse. **Privacy:** `event.text` is raw user
input. Per SPEC posture, store only `skillName` (a kebab-case public
identifier) + `args` *length/hash*, never `args` text. Structured slug
identifiers extracted from args (e.g. a task slug) are low-sensitivity and
acceptable *if* the skill declares them (§3) — never by free-text mining.

**`source: "extension"` should be skipped** for skill-invoke capture: that
source marks messages injected by other extensions via `sendUserMessage`, not
human/RPC skill invocations. (An extension that programmatically invokes a
skill is a separate, rarer case; out of scope for v1 of this feature.)

### Alternative seams rejected

- **A dedicated `skill_invoke` event does not exist** in Pi v0.80.10
  (`ExtensionEvent` union, `types.d.ts:761`, has no skill event). The idea
  doc's "upstream a dedicated event" recommendation remains the clean
  long-term path, but it is an upstream pi change — **out of scope for this
  map** (recorded in map Out-of-scope).
- **`tool_call` / `tool_result` events** fire for LLM tool calls, not skill
  commands (skills expand into prompt text, not tool calls). Wrong seam.
- **`context` event** (`types.d.ts` `ContextEvent`) fires per turn with
  `messages`, but the expanded skill block is already text inside `messages`;
  re-deriving "was this a skill invoke" from message content is fragile and
  content-heavy. `input` is the clean pre-expansion point.
- **`getCommands()`** (`types.d.ts:923`, returns `SlashCommandInfo[]`
  including `source: "skill"` entries — verified `agent-session.js:1840`)
  lists *available* skills, not *invocations*. Useful for §2/§3 discovery,
  not for capture.

### Code-level sketch (capture handler)

```typescript
// src/capture/skills.ts  (new file, mirrors src/capture/session-events.ts)
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Telemetry } from "../state.ts";
import { guard } from "../state.ts";
import { sha256 } from "../hash.ts";

const SKILL_PREFIX = "/skill:";

function recordSkillInvoke(t: Telemetry, rawText: string, source: string): void {
  if (!rawText.startsWith(SKILL_PREFIX)) return;
  const rest = rawText.slice(SKILL_PREFIX.length);
  const space = rest.indexOf(" ");
  const skillName = space === -1 ? rest : rest.slice(0, space);
  const argsText  = space === -1 ? "" : rest.slice(space + 1).trim();
  if (!skillName) return;

  // SPEC privacy posture: name + arg length/hash, never arg text.
  const payload = {
    skill_name: skillName,
    args_chars: argsText.length,
    args_hash:  argsText ? sha256(argsText) : null,
    input_source: source,
    // skills_package_version resolved per §2; skill-declared metadata per §3
  };
  // insertEvent() from session-events.ts pattern, type = "skill_invoke"
  t.enqueue(
    `INSERT OR IGNORE INTO session_events (event_id, session_id, unix_ms, type, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), t.state.sessionId, t.now(), "skill_invoke", JSON.stringify(payload)],
  );
}

export function registerSkillCapture(pi: ExtensionAPI, t: Telemetry): void {
  pi.on("input", async (event) => {
    guard(t, () => {
      if (event.source === "extension") return;      // skip programmatic injection
      recordSkillInvoke(t, event.text, event.source);
    });
    return { action: "continue" };                  // NEVER block expansion
  });
}
```

**Critical:** the handler MUST return `{action: "continue"}` (or nothing) and
never `transform`/`handled` — telemetry must not alter the input path
(SPEC §3 "telemetry must never break a session").

---

## Question 2 — Skills-package version: where discoverable, when available

### Answer

**The `task-workflow` package version is discoverable at runtime by walking up
from a skill's `filePath`/`baseDir` to the nearest `package.json`.** Verified
empirically against the installed package:

```
skill filePath: ~/.pi/agent/git/github.com/Y4shin/skills/skills/implement-task/SKILL.md
walk-up finds:  ~/.pi/agent/git/github.com/Y4shin/skills/package.json
  → name: "task-workflow", version: "2.5.1"
```

**How pi-telemetry reaches the skill path at runtime:** `pi.getCommands()`
(`ExtensionAPI`, `types.d.ts:923`) returns `SlashCommandInfo[]` including
skill commands (`agent-session.js:1840-1844`):

```typescript
// Built in agent-session.js getCommands() (line 1840):
const skills = this._resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill",
    sourceInfo: skill.sourceInfo,   // SourceInfo: { path, source, scope, origin, baseDir? }
}));
```

`SourceInfo` (`source-info.d.ts`): `{ path: string; source: string; scope:
SourceScope; origin: SourceOrigin; baseDir?: string }`. For a package skill,
`path` is the SKILL.md absolute path and `source` is the package source
string (git URL / npm name). pi-telemetry resolves the version by walking
from `path` (or `baseDir`) up to the first `package.json` and reading
`version` — exactly the pattern `src/version.ts` already uses for
pi-telemetry's own `getExtensionVersion()` (read `package.json` next to the
module).

**When available:** `getCommands()` is bound at extension-core bind time
(`agent-session.js:1887` `runner.bindCore({ ..., getCommands })`), which
happens during session setup, **after `session_start`** but before the first
`input`. So:
- **Not available at `session_start`** (the handler that stamps `ext_version`
  today runs first — `index.ts` comment + `sessions.ts`).
- **Available by the time `input` fires** (first user prompt). The skill
  capture handler can call `pi.getCommands()` at `input` time, build a
  `skillName → { sourceInfo, packageVersion }` map lazily (cache it), and
  stamp the version into the `skill_invoke` payload.

**Recommendation: store the version on the `skill_invoke` row's payload, NOT
as a new `sessions` column.** Rationale: (a) different skills in the same
session could come from different packages with different versions (a session
might invoke a task-workflow skill *and* a telemetry-eval skill); a single
session-level column would be wrong. (b) It keeps the schema migration-free
(§4). The version is a property of the *invocation*, not the *session*.

**Edge cases:**
- **Skill with no enclosing `package.json`** (global `~/.pi/agent/skills/foo/SKILL.md`): version is `null`. Fine — the `skill_invoke` payload's
  `skills_package_version` is simply absent/`null`.
- **`sourceInfo.source` already distinguishes packages** — pi-telemetry
  should store both `skill_source` (the package source string) and
  `skills_package_version` so a user can group by source *and* version.
- **Stale cache across `/reload`:** `resources_discover` fires with
  `reason: "reload"` (`extensions.md:282,1282`). pi-telemetry should listen
  and invalidate its skill→version cache on reload.

### Code-level sketch (version resolution)

```typescript
// src/capture/skills.ts  (continued)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function resolvePackageVersion(filePath: string): { source: string | null; version: string | null } {
  let dir = dirname(filePath);
  while (dir && dir !== "/") {
    const pkgPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return { source: pkg.name ?? null, version: pkg.version ?? null };
    } catch { /* not found, keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { source: null, version: null };
}
```

Cache: `Map<skillName, { sourceInfo, pkgVersion }>`, rebuilt on
`resources_discover`. Looked up in `recordSkillInvoke`.

---

## Question 3 — Skill self-declared metadata: frontmatter keys vs tool call

### Mechanism (a) — Frontmatter `metadata` keys

**Spec-compliant and requires NO skills-package edit to *read*.** The Agent
Skills specification (`agentskills.io/specification`, verified) defines an
optional `metadata` frontmatter field:

> `metadata` — No — Arbitrary key-value mapping for additional metadata.
> "A map from string keys to string values. Clients can use this to store
> additional properties not defined by the Agent Skills spec."

Pi already documents it (`docs/skills.md:145` "metadata | No | Arbitrary
key-value mapping") and its parser accepts it (`SkillFrontmatter` interface,
`skills.d.ts`: `[key: string]: unknown`).

**However:** the loaded `Skill` object (`skills.d.ts` `Skill` interface)
**discards `metadata`** — `loadSkillFromFile` (`skills.js:211`) only surfaces
`name`, `description`, `disableModelInvocation`. So pi-telemetry cannot get
`metadata` from `getCommands()`/`getSkills()`. It must **re-read the SKILL.md
at `sourceInfo.path`** and parse the frontmatter itself to recover `metadata`.

**Proposed convention** (pi-telemetry defines; skills opt in by adding keys):

```yaml
# skills/implement-task/SKILL.md
---
name: implement-task
description: ...
metadata:
  telemetry.capture: "task,map,sliceCount"   # arg-position or named keys to record
---
```

pi-telemetry reads `metadata.telemetry.capture`, and when that skill is
invoked, extracts the named values from the parsed args (by position or
name) into the `skill_invoke` payload as structured fields. Because these are
kebab-case slug identifiers the skill itself declares, this stays inside the
v1 privacy posture (no free-text mining).

**Requires editing the read-only skills package?**
- To *read* `metadata`: **NO.** pi-telemetry re-reads SKILL.md from
  `sourceInfo.path`; any skill anywhere can carry `metadata` and be captured.
- To *populate* `metadata.telemetry.capture` for the task-workflow skills
  specifically: **YES** — someone must add the keys to each
  `~/.pi/.../skills/<name>/SKILL.md`. That is a skills-package edit, gated by
  the user's consent. Until then, task-workflow skills invoke with name +
  version + arg length/hash but *no structured target slug*.

### Mechanism (b) — A tool call the skill makes to enrich its invocation

**Already proven in this repo.** `src/feedback.ts` registers a
`submit_feedback` tool (`pi.registerTool`, `feedback.ts:109`) that inserts a
`feedback` row carrying `session_id`, `run_id`, `turn_index` from
`t.state.correlation()`. A skill-invoke-enrichment tool is the same pattern:
the skill calls it mid-run to attach structured metadata to "the current
invocation."

```typescript
// src/capture/skills.ts  (sketch)
pi.registerTool({
  name: "telemetry_skill_context",   // or "tag_skill_invocation"
  description: "Attach structured metadata to the current skill invocation in the telemetry store.",
  parameters: Type.Object({
    target: Type.Optional(Type.String()),      // e.g. "pi-telemetry" task slug
    map: Type.Optional(Type.String()),
    slice: Type.Optional(Type.String()),
    sliceCount: Type.Optional(Type.Number()),
    // skill-defined arbitrary key-value:
    extra: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  async execute(_id, params) {
    guard(t, () => enrichCurrentSkillInvoke(t, params));   // UPDATE/insert payload
    return { content: [{ type: "text", text: "Recorded." }], details: {} };
  },
});
```

**Attribution contract (the hard part):** the `input` event that recorded the
`skill_invoke` row fired *before* the agent turn, so it has no `turn_id`/`run_id`
yet (turn starts at `turn_start`, after `before_agent_start`). The enrichment
tool fires *during* the turn, so `t.state.correlation()` has `runId`/`turnId`.
To attach enrichment to the right invocation, pi-telemetry needs a join key.
Two options:
1. **Most-recent `skill_invoke` in this session** (simple, fragile if two
   skills invoke back-to-back in one turn — rare).
2. **A `correlation_id` minted at `input` time, surfaced to the skill** (clean,
   but the skill must echo it — needs a way to pass it from the `input` handler
   into the expanded skill body, which Pi does not support today without
   `transform`). **Likely too invasive.**
3. **Store `run_id`/`turn_id` on the `skill_invoke` row opportunistically** by
   updating it at `turn_start` (the most recent un-attributed skill_invoke in
   the session gets the upcoming turn's ids). Then the enrichment tool matches
   on `session_id` + `run_id` + `turn_id`. **Recommended** — no skill
   cooperation needed, and it also fixes the "which turn did this skill
   start?" question for free.

**Requires editing the read-only skills package?**
- To *offer* the tool: **NO** — pi-telemetry registers it; any skill can call
  it.
- To *make* the task-workflow skills actually call it: **YES** — the skill
  bodies (SKILL.md prose) must instruct the model to call
  `telemetry_skill_context`. Without that, the tool exists but is never
  called, so no enrichment. Gated by user consent.

### Verdict table (the user's consent gate)

| Mechanism | Read needs skills edit? | To populate for task-workflow needs skills edit? | Attribution | Spec status |
|---|---|---|---|---|
| (a) frontmatter `metadata` keys | **NO** (re-read SKILL.md) | **YES** (add keys to each SKILL.md) | static, known at `input` time | Agent Skills standard `metadata` field |
| (b) tool call mid-run | **NO** (pi-telemetry registers tool) | **YES** (add prose instructing the call) | needs run/turn correlation (opt 3 above) | pi-telemetry-defined tool |

**Both mechanisms require a skills-package edit to be *useful* for the
task-workflow skills specifically**, but neither requires one to *function* —
pi-telemetry can ship both, and any skill (including future ones, or ones the
user consents to edit) can opt in. This is the key fact for the grilling task.

**Recommended starting answer for grilling:** ship **both**, decoupled:
(a) frontmatter `metadata.capture` for *static* args known at invoke time
(task/map/slice slugs the skill is always invoked with), and (b) the
`telemetry_skill_context` tool for *dynamic* metadata only known mid-run
(slice count discovered after planning, outcome flags at the end). They
compose; neither blocks the other.

---

## Question 4 — Schema: `session_events` JSON row vs dedicated table

### Recommendation: `session_events` with `type='skill_invoke'` (no migration)

**Rationale:**
- SPEC §1.7 *deliberately* made `session_events` generic (`type` + JSON
  `payload`) to absorb new event classes without a migration — this is exactly
  that case. The existing `src/capture/session-events.ts` `insertEvent()`
  helper is reused as-is.
- A dedicated `skill_invocations` table would add queryable columns
  (`skill_name`, `skills_package_version`, `target_slug`, …) but costs a
  migration (new table DDL, `PRAGMA user_version` bump) and duplicates the
  generic-event pattern. The queryability gain is real but small — SQLite
  `json_extract(payload, '$.skill_name')` is cheap and can be indexed with a
  generated column later if needed.
- Keeps multi-version coexistence trivial (older ext versions simply never
  write `skill_invoke` rows; no schema divergence).

**Payload JSON shape** (stored in `session_events.payload`):

```json
{
  "skill_name": "implement-task",
  "skill_source": "task-workflow",
  "skills_package_version": "2.5.1",
  "args_chars": 18,
  "args_hash": "sha256:…",
  "input_source": "interactive",
  "run_id": null,
  "turn_id": null,
  "turn_index": null,
  "target": "pi-telemetry",
  "map": "skill-workflow-telemetry",
  "slice": null,
  "slice_count": null,
  "extra": {}
}
```

`run_id`/`turn_id`/`turn_index` start `null` (the `input` event predates the
turn) and are filled at `turn_start` (§3 opt 3). `target`/`map`/`slice`/
`slice_count`/`extra` are populated by frontmatter `metadata.capture` (static,
at `input` time) and/or the `telemetry_skill_context` tool (dynamic, mid-run);
they are `null` when the skill declared nothing.

**Query it enables** (for the compare-versions-and-skills feature):

```sql
-- Cost/tool-failure by skills-package version
SELECT
  json_extract(payload, '$.skills_package_version') AS pkg_version,
  json_extract(payload, '$.skill_name')             AS skill,
  COUNT(*)                                          AS invocations,
  ROUND(SUM(t.cost_total_usd), 3)                   AS cost_usd,
  SUM(CASE WHEN te.is_error THEN 1 ELSE 0 END)      AS tool_errors
FROM session_events se
JOIN turns t  ON t.session_id = se.session_id
LEFT JOIN tool_executions te ON te.session_id = se.session_id
WHERE se.type = 'skill_invoke'
GROUP BY pkg_version, skill
ORDER BY pkg_version, skill;
```

(The canned-query feature task will refine this join; the sketch shows the
shape is queryable today with no new columns.)

**When to revisit a dedicated table:** if `skill_invoke` rows become frequent
enough that `json_extract` scans show up in query plans, add a generated
column + index (`ALTER TABLE session_events ADD COLUMN skill_name GENERATED
ALWAYS AS (json_extract(payload,'$.skill_name')) VIRTUAL; CREATE INDEX …`).
That is still a migration, but deferred until evidence demands it. Not now.

---

## Question 5 — Run-level correlation pressure (parent_run_id / depth)

### Answer

**Not required for the core skill-invocation feature, but recommended as a
separate, parallel feature — and the skill-invocation feature makes it more
valuable, not more urgent.**

Current state (verified against the live DB, 98 sessions):
- `parent_session_id` populated on 15/98 (subagent sessions via
  `PI_SUBAGENT_*` env fallback, `lineage.ts`).
- `parent_run_id` populated on **0/98**. `depth` populated on **0/98**.
- HANDOFF.md coherence-refactor #1 is the known fix: `buildEnvBlock` must
  derive from runtime state (`t.state.sessionId`/`runId`/`lineage.depth`) not
  re-export `process.env`. But that fix only helps *if* an emitter sets the
  env vars on children — pi-subagents sets `PI_SUBAGENT_*` (already read by
  the fallback) but does **not** set `PI_TELEMETRY_*`, and emits no bus events
  today (`lineage.ts` listeners are no-ops in vanilla use).

**Why skill-invocation capture does not *need* run-level lineage:** the
`skill_invoke` row is written in the *top-level* session (the one where the
user typed `/skill:…`). The subagent fan-out (tdd-worker, slice-verifier, …)
happens in *child* sessions with their own `agent_label`. Per-skill +
per-version + per-target grouping (the dimensions the user selected) joins on
`session_id` and does not need to reconstruct the parent→child run tree.

**Why run-level lineage is *valuable* alongside it:** to answer "one
invocation = the whole implement-task→finalize-task episode including its
subagent tree" (which the user did NOT select but which the map's Fog lists),
you need `parent_run_id` + `depth` populated. That requires:
1. The HANDOFF coherence-refactor #1 (`buildEnvBlock` derive-from-runtime).
2. An emitter: either pi-subagents emitting `pi-telemetry:agent.spawned`/
   `.completed` bus events (SPEC §4 phase 2), or pi-subagents setting
   `PI_TELEMETRY_*` env vars (today it sets only `PI_SUBAGENT_*`, already
   read by the fallback).

**Recommendation:** keep run-level lineage in the map's **Fog** for now. The
three graduated features (capture, version, queries) do not depend on it.
The grilling task should ask the user whether to also graduate a lineage
feature (it is a clean, separate feature with its own slices: fix
`buildEnvBlock`, add a pi-subagents env/bus emitter or document the manual
env-var contract, add `/tm tree` depth rendering). If yes, it can run in
parallel; if no, it stays in Fog.

---

## Newly-sharp decisions for the grilling task (`swt-grill-decisions`)

1. **Self-declaration mechanism** — ship (a) frontmatter `metadata.capture`
   *and* (b) the `telemetry_skill_context` tool, or just one?
2. **Skills-package consent** — both mechanisms need a skills-package edit to
   be *useful* for task-workflow specifically. Does the user consent to editing
   `/home/pplattner/Projects/skills` (and the installed
   `~/.pi/agent/git/github.com/Y4shin/skills`) to add `metadata` keys and/or
   tool-call prose? If yes → graduate a `manual` task. If no → the features
   ship with the capability but task-workflow stays un-enriched until later.
3. **Schema** — confirm `session_events` `type='skill_invoke'` JSON rows (no
   migration) per §4.
4. **Run-level correlation scope** — graduate a parallel lineage feature from
   Fog, or leave it? (§5.)
5. **Mid-stream `steer`/`followUp` gap** — accept and document, or also hook
   a second seam? (§1 gap.)
6. **Feature graduation + order** — confirm the three features and their
   slice breakdown (below).

## Suggested feature graduation + slice sketches (for grilling to confirm)

### Feature A — `swt-skill-invoke-capture` (type: feature)
- Slice 1 (s): `input` handler → `skill_invoke` session_events row (name +
  args length/hash + source), privacy test (no arg text). Mirrors
  `session-events.ts`. Skip `source:"extension"`. Return `continue`.
- Slice 2 (m): skills-package version resolution — `getCommands()` +
  walk-up `package.json` + cache invalidated on `resources_discover`. Stamp
  `skill_source` + `skills_package_version` into the payload.
- Slice 3 (m): frontmatter `metadata.capture` reader — re-read SKILL.md from
  `sourceInfo.path`, parse `metadata.telemetry.capture`, extract named/positional
  slugs from args at `input` time into `target`/`map`/`slice`/etc.
- Slice 4 (m): `telemetry_skill_context` tool — register tool, attribute to
  current run/turn via the `turn_start` back-fill (§3 opt 3), merge into the
  session's most-recent `skill_invoke` payload.
- Slice 5 (s): `turn_start` back-fill — set `run_id`/`turn_id`/`turn_index`
  on the session's most-recent un-attributed `skill_invoke` row.

### Feature B — `swt-compare-versions-queries` (type: feature)
- Slice 1 (s): `query_telemetry` preset `skill_cost` — cost/tool-errors by
  skill + skills-package version (the §4 SQL).
- Slice 2 (s): `/tm skills` command — list skills invoked, counts, cost,
  version, target.
- Slice 3 (s): `query_telemetry` preset `skill_versions` — A/B compare two
  versions of the same skill (cost/turns/tool-failure delta).

### Feature C (optional, from Fog) — `swt-run-level-lineage` (type: feature)
- Slice 1 (m): HANDOFF coherence-refactor #1 — `buildEnvBlock` derive from
  runtime state + test.
- Slice 2 (m): emitter — pi-subagents env/bus contract (may need a small
  upstream or settings change; research the exact seam in-slice).
- Slice 3 (s): `/tm tree` depth rendering + `agent_tree` preset depth column.

### Manual task (conditional) — `swt-skills-consent-edits` (type: manual)
Only if grilling gives consent: add `metadata.telemetry.capture` keys and/or
`telemetry_skill_context` call prose to each task-workflow SKILL.md, in both
the read-only source (`/home/pplattner/Projects/skills`) and the installed
copy (`~/.pi/agent/git/github.com/Y4shin/skills`).

## Work to stay in Fog

- **Run-level lineage** — unless grilling graduates Feature C.
- **Mid-stream `steer`/`followUp` capture** — unless grilling decides to hook
  a second seam; default is to document the gap.
- **`telemetry_skill_context` attribution via a correlation_id passed into
  the skill body** — needs Pi `transform` support; too invasive for now.

## Work to move to Out of scope

- **Upstreaming a dedicated `skill_invoke` event into Pi** — clean long-term
  seam, but an upstream pi change. The `input` seam is sufficient for v1.
  (Already in map Out-of-scope; confirmed.)
- **Custom commands (`/cmd`) and prompt templates (`/template`)** — same
  `input` seam could capture them, but the user asked about *skills*
  specifically. Leave for a future map; do not broaden this one.
- **A dedicated `skill_invocations` table** — `session_events` JSON is
  sufficient (§4); revisit only if query perf demands it.
- **Content capture of skill args** — privacy posture; opt-in flag possible
  later but not in this map.

## Sources

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  (lines 615–629 `InputEvent`/`InputSource`/`InputEventResult`; 761
  `ExtensionEvent` union — no skill event; 839–925 `ExtensionAPI` incl.
  `on("input")`, `getCommands()`; 872 `on("input")` overload)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  (816–845 `emitInput` + expansion order; 956–976 `_expandSkillCommand`; 995
  `steer()` bypasses `emitInput`; 1827–1847 `getCommands()` builds skill
  `SlashCommandInfo`)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/source-info.d.ts`
  (`SourceInfo` shape)
- `node_modules/@earendil-works/pi-coding-agent/dist/core/skills.d.ts` +
  `skills.js` (88–110 `createSkillSourceInfo`; 211–240 `loadSkillFromFile`
  discards `metadata`; `Skill` interface has `filePath`/`baseDir`/`sourceInfo`)
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js`
  (95,98 → `session.prompt`) and `modes/rpc/rpc-mode.js` (302 →
  `session.prompt(..., {source:"rpc"})`) — path coverage
- `docs/extensions.md` (878 `input` event; 371 `resources_discover`; 933
  `ctx.mode`)
- `docs/skills.md` (145 `metadata` field; 184 "Unknown frontmatter fields are
  ignored")
- `https://agentskills.io/specification` (Agent Skills standard: `metadata`
  is an optional arbitrary key-value mapping)
- This repo: `src/capture/session-events.ts` (`insertEvent` pattern),
  `src/capture/sessions.ts` (version stamping), `src/version.ts`
  (`package.json` walk), `src/feedback.ts` (`registerTool` + correlation
  pattern), `src/lineage.ts` (lineage state, `buildEnvBlock`), `SPEC.md` §1.7
- Live DB queries (98 sessions; `parent_run_id`/`depth` all NULL;
  `session_events` has only `model_change`/`compaction`)
- Installed skills package `~/.pi/agent/git/github.com/Y4shin/skills/package.json`
  (name `task-workflow`, version `2.5.1`; git HEAD `2370b44`,
  `v2.4.0-4-g2370b44`)
