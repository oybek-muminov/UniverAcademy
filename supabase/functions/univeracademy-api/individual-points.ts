import { fail } from "./fault.ts";
import { ratio } from "./ordinary.ts";
import type { Ratio } from "./ordinary.ts";

// This limit applies only to configured individual QUESTION bases, not generic Ratio/totals.
export const INDIVIDUAL_POINTS_PATTERN = /^(?:(?:0|[1-9]|[12][0-9])(?:\.[0-9]{1,3})?|30(?:\.0{1,3})?)(?![\s\S])/;

export function parseIndividualQuestionPoints(input: unknown): Ratio {
  if (typeof input !== "string" || !INDIVIDUAL_POINTS_PATTERN.test(input)) {
    fail("VALIDATION_ERROR", 422);
  }
  const [whole, fraction = ""] = input.split(".");
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) fail("VALIDATION_ERROR", 422);
  return ratio(numerator, 10n ** BigInt(fraction.length));
}

