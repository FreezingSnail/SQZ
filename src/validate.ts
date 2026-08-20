/**
 * SQZ validation.
 *
 * v1: SQZPayload schema validation via ajv against sqz-schema.json — kept as
 *     tooling-only (not on the wire since v2).
 * v2: validateLine — local grammar check of a plain SQZ line. Microsecond-fast,
 *     zero network, no model roundtrip.
 */

import { Ajv } from "ajv";
import schema from "../sqz-schema.json" with { type: "json" };
import type { Lexicon } from "./types.js";
import { parseLine } from "./line.js";

const ajv = new Ajv({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePayload(value: unknown): ValidationResult {
  if (validate(value)) {
    return { valid: true, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
  );
  return { valid: false, errors };
}

/**
 * v2 line validation. Checks: non-empty; valid mode; Δ[...] target with at
 * least one file; every symbol known to the lexicon; balanced quotes/brackets;
 * no stray tokens. Pure local computation.
 */
export function validateLine(line: string, lexicon: Lexicon): ValidationResult {
  const ast = parseLine(line, lexicon);
  if (ast.errors.length > 0) {
    return { valid: false, errors: ast.errors };
  }
  return { valid: true, errors: [] };
}

export { schema };
