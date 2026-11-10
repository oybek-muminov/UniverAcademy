import { createOwnerPort } from './owner-port.ts';
import type { OwnerPortOptions } from './owner-port.ts';

// Local constructor remains isolated to an explicitly typed fixture boundary.
export function createLocalOwnerPort(options: OwnerPortOptions & { mode: 'local_fixture' }) {
  if (options.mode !== 'local_fixture') throw new Error('CONTRACT_HASH_MISMATCH');
  return createOwnerPort(options);
}
