import { fail } from "./fault.ts";

function sameExactInteger(source: string, value: number): boolean {
  const match = source.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return false;
  let digits = (match[2] + (match[3] || "")).replace(/^0+/, "");
  if (!digits) return value === 0;
  const shift = BigInt(match[4] || "0") - BigInt((match[3] || "").length);
  if (shift < 0n) {
    const zeroes = digits.match(/0*$/)![0].length;
    if (-shift > BigInt(zeroes)) return false;
    digits = digits.slice(0, digits.length - Number(-shift));
  } else {
    if (BigInt(digits.length) + shift > 16n) return false;
    digits += "0".repeat(Number(shift));
  }
  return BigInt(match[1] + digits) === BigInt(value);
}

// Node24 candidate: source lexemes prevent a fractional token such as
//7.0000000000000001 from silently becoming a valid revision7 after JSON.parse.
// Integer-equivalent1e3/1000.0 remain accepted. No additional business cap.
export function parseStaffJson(raw: string): unknown {
  let rounded = false, sourceMissing = false;
  const parsed = JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
    if (["expected_revision", "expected_membership_revision", "duration_seconds", "position"].includes(key) &&
        typeof value === "number" && Number.isSafeInteger(value)) {
      if (!context?.source) sourceMissing = true;
      else if (!sameExactInteger(context.source, value)) rounded = true;
    }
    return value;
  });
  if (sourceMissing) fail("SERVICE_UNAVAILABLE", 503);
  if (rounded) fail("VALIDATION_ERROR", 422);
  return parsed;
}
