import { fail } from "./fault.ts";

// Internal exact values only, NOT the OpenAPI number representation or a DB schema.
// Individual question bounds are enforced separately; generic ratios/totals remain exact.
export type Ratio = Readonly<{ numerator: bigint; denominator: bigint }>;

export function ratio(numerator: bigint, denominator = 1n): Ratio {
  if (denominator <= 0n || numerator < 0n) fail("INVALID_GRADING_CONFIG", 422);
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

function add(a: Ratio, b: Ratio): Ratio {
  return ratio(a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator);
}

export type PublishedQuestion = Readonly<{
  id: string;
  optionIds: readonly string[];
  correctOptionId: string;
  individualPoints: Ratio | null;
}>;

export type PublishedTest = Readonly<{
  demoId: string;
  versionId: string;
  durationMs: number;
  individualEnabled: boolean;
  questions: readonly PublishedQuestion[];
}>;

export function validatePublishedTest(test: PublishedTest): void {
  if (typeof test.individualEnabled !== "boolean" || test.questions.length === 0 ||
    !Number.isSafeInteger(test.durationMs) || test.durationMs <= 0) {
    fail("INVALID_GRADING_CONFIG", 422);
  }
  const ids = new Set<string>();
  for (const question of test.questions) {
    if (ids.has(question.id)) fail("INVALID_GRADING_CONFIG", 422);
    ids.add(question.id);
    if (question.optionIds.length !== 4 || new Set(question.optionIds).size !== 4 ||
      !question.optionIds.includes(question.correctOptionId)) fail("INVALID_OPTION", 422);
    if (test.individualEnabled) {
      const points = question.individualPoints;
      if (!points || typeof points.numerator !== "bigint" || typeof points.denominator !== "bigint" ||
        points.numerator <= 0n || points.denominator <= 0n ||
        points.numerator > 30n * points.denominator ||
        (points.numerator * 1000n) % points.denominator !== 0n) fail("INVALID_GRADING_CONFIG", 422);
    }
  }
}

export type ExactOrdinary = Readonly<{
  earned: Ratio;
  maximum: Ratio;
  percentage: Ratio;
  calculatedAt: number;
}>;

export function ordinaryScore(
  test: PublishedTest,
  answers: ReadonlyMap<string, string | null>,
  calculatedAt: number,
): ExactOrdinary {
  validatePublishedTest(test);
  let earned = ratio(0n);
  let maximum = ratio(0n);
  for (const question of test.questions) {
    const base = test.individualEnabled ? question.individualPoints! : ratio(1n);
    maximum = add(maximum, base);
    if (answers.get(question.id) === question.correctOptionId) earned = add(earned, base);
  }
  return {
    earned,
    maximum,
    percentage: ratio(100n * earned.numerator * maximum.denominator,
      earned.denominator * maximum.numerator),
    calculatedAt,
  };
}
