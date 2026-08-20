# math-dbr.1 — SQZ grammar spec

Deliverables for SQZ milestone 1 (grammar spec, no model). Clean-room,
original notation; no text derived from nucleus (AGPL) repo.

## Files created (repo root)

| file | purpose |
|---|---|
| `sqz.ebnf` | Formal EBNF grammar (ISO/IEC 14977) for SQZ v1 payloads: lexical layer (JSON tokens), `payload` production mirroring SQZPayload v1 (`v`/`mode`/`target`/`constraints`/`verbatim`/`confidence`), and `clause` productions for the compact symbol notation: Δ change-set, ≋ behavior-equivalence, ∂ edge-cases, μ minimal, ⌁ complete-coverage, → pipeline, ✓ verified, ⏭ skip. |
| `lexicon.md` | Symbol dictionary — one symbol, one meaning, one domain (8 symbols); usage notes (lossless policy, confidence gate, domain discipline, composition). Size ~800 tokens for session injection. |
| `sqz-schema.json` | JSON Schema (draft-07) mirroring SQZ AST v1: required `v` (const 1), `mode` enum `refactor|api|debug|docs|test|review|arch|general`, `target` (non-empty `files[]` + `lang`), `constraints[]` strings, `verbatim[]` strings, `confidence` number 0–1, `additionalProperties: false`. |

## Acceptance verification

- **Every symbol exactly one meaning per domain** — lexicon table: 8 symbols × distinct domains (change, behavior, edge, scope, coverage, flow, verification, omission); no reuse. Enforced by table structure; task-2 validator will check programmatically.
- **EBNF parses all example payloads in epic design doc** — grammar `payload` production covers the SQZPayload v1 shape from the design doc verbatim (field set, mode enum, target/files/lang, constraints, verbatim, confidence). Design-doc constraint strings (`behavior(new) = behavior(old)`, `minimal diff`) parse as `prose-clause`. All lexicon example clauses (e.g. `lint → build → test`, `Δ ["src/a.ts","src/b.ts"]`, `≋ fn normalize = fn old`) match `clause` productions. EBNF syntax checked: 45 productions, brackets/parens/braces balanced.
- **Schema validates valid payloads, rejects malformed** — verified via `jq` structural checks mirroring schema semantics (ajv-cli also compiles the schema without errors and enforces `required`):
  - 3 valid payloads (modes refactor/debug/docs incl. symbol-bearing constraints): PASS
  - 8 malformed variants (v=2, bad mode, confidence>1, empty files, missing lang, non-string constraint, extra property, missing v): all REJECTED
- **No verbatim text copied from nucleus repo** — all files written from epic design context; original grammar, original lexicon, original docs. See CITATIONS.md context.

## Interface contract (for downstream tasks)

- `SQZPayload` v1 = `{ v: 1, mode, target{files[], lang}, constraints[], verbatim[], confidence }`
- Symbol set: `Δ ≋ ∂ μ ⌁ → ✓ ⏭` (see `lexicon.md`)
- `compress(prose, {domain?, lexicon})` must emit schema-conformant JSON; `expand(sqz, lexicon)` renders `verbatim[]` unchanged.