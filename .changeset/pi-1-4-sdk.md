---
"@y4shin/pi-telemetry": patch
---

Update every dependency, and follow the SDK's new event shape.

- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` move from the
  0.80 line to `^1.4.0`, `typebox` to `^1.4.3`, `@types/node` to 26.6.6, and
  TypeScript to `^7.0.2`.
- `before_agent_start` is now a union of a user-started run and a run started
  by an idle custom message. The telemetry narrows on it: a user run records
  the prompt length as before, and a custom-message run records zero prompt
  characters because no prompt was submitted. The SDK no longer exposes
  `prompt` on the shared event, so the old read was a type error.
- A test context is typed as the SDK's `ExtensionToolContext`, which is what
  the tool `execute` signature now takes.
- An `overrides` pin takes undici to a patched release; the high advisories
  came from the version `pi-coding-agent` resolves, not from this package.
