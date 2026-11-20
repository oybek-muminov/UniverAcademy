import {StorageUnavailable} from './postgres-transaction.ts';

// PostgreSQL and the Worker both report UTC, but their samples can have a
// small offset. Detect a backward jump only against the same clock.
export function telegramRequestClock(readWorker:()=>number) {
  let previousWorker = 0, previousDatabase = 0;
  function forward(value:number, previous:number) {
    if (!Number.isSafeInteger(value) || value < previous) throw new StorageUnavailable('not_committed');
    return value;
  }
  return {
    worker() { return previousWorker = forward(readWorker(), previousWorker); },
    database(value:number) { return previousDatabase = forward(value, previousDatabase); },
  };
}
