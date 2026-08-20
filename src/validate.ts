/**
 * SQZPayload schema validation.
 * Uses ajv against sqz-schema.json (draft-07) from math-dbr.1.
 * Every compressor output is validated before acceptance; failures trigger
 * the retry → passthrough ladder.
 */

import { Ajv } from "ajv";
import schema from "../sqz-schema.json" with { type: "json" };

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

export { schema };
