# math-dbr.4 — squeeze plugin hooks (opencode)

Status: CLOSED.

## Deliverables

### Plugin (TypeScript, opencode)

- `.opencode/plugins/squeeze.ts` — auto-discovered plugin entry (thin re-export).
- `src/plugin/squeeze.ts` — `SqueezePlugin` (opencode `Plugin`): provider factory,
  deps builder, hook wiring, per-session lexicon state.
- `src/plugin/config.ts` — `SqueezeConfig` + `loadConfig`. Resolution order:
  plugin options (tuple form) → env (`SQZ_ENABLED`, `SQZ_PROVIDER`, `SQZ_MODEL`,
  `SQZ_THRESHOLD`, `SQZ_AUDIT`, `SQZ_EXPAND`, `SQZ_RETRIES`) → `squeeze.config.json`
  (project root) → defaults. Kill switch = `enabled: false` (hooks no-op,
  session byte-identical to no-plugin).
- `src/plugin/format.ts` — SQZ wire envelope: `[SQZ v1]` payload, `[SQZ lexicon]`
  (first message only), `[SQZ original]` (audit mode). Assistant-side candidate
  detection: marker block, ` ```json ` fence, or bare JSON — schema-validated,
  prose never matches.
- `src/plugin/core.ts` — pure, dependency-injected `processUserText` /
  `processAssistantText` + `expandSqzInText`. Threshold gate (min estimated
  tokens), confidence gate (>= 0.9 per lexicon.md), double-compress guard.
- `src/plugin/harness.ts` — e2e session harness (`SqueezeHarness`): transcripts
  user prose → model input → assistant output → user output; drives the same
  core functions the plugin uses, no live opencode/model needed.
- `squeeze.config.json` — shipped config (defaults: `enabled:false`,
  `provider:"rule"`, `model:"qwen3:1.7b"`, `threshold:60`, `audit:false`,
  `expand:true`, `retries:2`).
- devDependency added: `@opencode-ai/plugin@1.18.19` (types only).

### Hook mapping (verified against opencode 1.18.18 source + types)

opencode's `chat.message` hook fires only on **user message receipt** (before
the LLM sees it) — this is the pre hook: compress user prose into the SQZ
envelope, inject the session lexicon once, audit mode prepends original prose in
a fenced block. There is no post-render assistant hook in the plugin surface, so
the assistant side uses `experimental.chat.messages.transform` (fires when the
next model request is assembled): detect SQZ payloads in assistant text parts,
expand to prose in place — the stored parts (what renders) and the model's
subsequent context both carry expanded prose. Caveat: with no live model
running, the user sees expanded prose after the next request assembly, not
mid-stream.

### Tests (vitest, permanent, `tests/plugin/`)

- `config.test.ts` — resolution order, env parsing, kill switch, corrupt-file fallback.
- `format.test.ts` — envelope roundtrip, candidate detection (marker/fence/bare),
  schema rejection of prose, overlap dedupe.
- `core.test.ts` — threshold/confidence gates, audit, every failure path →
  original prose unchanged, expand toggle, unknown-symbol audit, idempotency.
- `plugin.test.ts` — SDK-shaped hook wiring: compression, once-per-session
  lexicon (per-session isolation), kill switch, synthetic-part skip, assistant
  expansion, no-double-compress, non-text parts ignored.
- `e2e.test.ts` — full-session harness: prose in → compressed payload to model →
  expanded output to user; audit round-trip; kill switch byte-identical;
  provider-down / parse-fail / refusal / unknown-symbol fallbacks; lexicon once.
- Fixtures: `tests/plugin/fixtures/config-enabled/`, `config-corrupt/`.

## Verification

- `npm test` — 126 tests green (12 files), no daemon/model needed.
- `tsc --noEmit` — clean (src + tests + `.opencode` now in tsconfig include).
- Bun smoke (opencode loader runtime): `SqueezePlugin` loads, user prose →
  `[SQZ v1]` envelope, assistant `[SQZ v1]` → expanded prose.

## Usage

```
# kill switch (default in repo): enabled:false → session identical to no-plugin
# enable compression with the deterministic RuleProvider (no model):
npx opencode  # after setting squeeze.config.json enabled:true
# or plugin options tuple in opencode.json: ["squeeze", { "enabled": true, "provider": "ollama", "model": "qwen3:1.7b" }]
```

Invariant: user's original message always recoverable (verbatim[]/audit block),
never silently mutated; all failure paths (provider down, parse fail, empty
output, unknown symbol, corrupt config) fall back to original prose unchanged.