import { StudentFailure } from './transport.ts';
import type { Result } from './flow.ts';

// Student point fields only, per owner handoff21403a...; percentage stays2dp.
export function studentPointsDisplay(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9](?![\s\S])/.test(value)) {
    throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
  }
  return value;
}

// Rendering only: precision and rounding belong to the owner-validated response.
// Accept plain display text without choosing a wire schema or changing its digits.
export function localizeServerDisplay(value: unknown, decimalMark: '.' | ',' = '.'): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]+(?![\s\S])/.test(value)) {
    throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
  }
  return value.replace('.', decimalMark);
}

// Exact DecimalDisplay2 from review schema49defb...e010. No numeric conversion.
export function display2(value: unknown, decimalMark: '.' | ',' = '.'): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)\.[0-9]{2}(?![\s\S])/.test(value)) {
    throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
  }
  return value.replace('.', decimalMark);
}

export function historySummary(result: Result | null, official: boolean, decimalMark: '.' | ','): string {
  return result ? `${official ? 'Rasmiy natija' : 'Tarixiy natija, rasmiy emas'} · ${localizeServerDisplay(result.earned, decimalMark)} / ${localizeServerDisplay(result.maximum, decimalMark)}` : 'Rasmiy natija yo‘q';
}
