import { ApiFault, fail } from "../fault.ts";

// Driver boundary only. No URL, credential, pool construction or network fallback.
export type Statement = { name: string; text: string; values: readonly unknown[] };
export type Rows = { rows: Record<string, unknown>[]; rowCount: number | null };
export interface PgClient {
  query(statement: Statement): Promise<Rows>;
  release(discard?: boolean): void;
}
export interface PgPool { connect(): Promise<PgClient> }
export class StorageUnavailable extends ApiFault {
  readonly outcome: "not_committed" | "commit_unknown";
  constructor(outcome: "not_committed" | "commit_unknown") { super("SERVICE_UNAVAILABLE", 503); this.outcome = outcome; }
}
export function integer(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("RESPONSE_INVARIANT_FAILED", 500);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) fail("RESPONSE_INVARIANT_FAILED", 500);
  return n;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type LockedTransaction = { client: PgClient; personIds: readonly string[]; now: number };
export type IdentityTransaction = LockedTransaction & { telegramId: number };
export type PreparedRunEvent = Readonly<
  | { kind: "rollback_start"; error: unknown }
  | { kind: "commit_ack" | "commit_unknown" | "rollback_ack" | "rollback_unknown" }
  | { kind: "cleanup"; discardRequested: boolean; releaseInvocation: "returned" | "threw" | "unavailable" }
>;
type PreparedHooks = { beforeCommit: () => void; observe?: (event: PreparedRunEvent) => void };
const nativeThen = Promise.prototype.then;
const ignoreSettlement = () => undefined;
function sinkNativePromise(value: unknown): void {
  // The intrinsic checks its receiver's Promise brand. Never read a caller's
  // `then` property or assimilate an arbitrary thenable; neither path is awaited.
  try { Reflect.apply(nativeThen, value, [ignoreSettlement, ignoreSettlement]); } catch { /* not a native Promise */ }
}
function observePrepared(hooks: PreparedHooks, event: PreparedRunEvent): void {
  try { sinkNativePromise(hooks.observe?.(Object.freeze(event))); } catch { /* notification is not authoritative */ }
}
function cleanupPrepared(client: PgClient | undefined, discardRequested: boolean, hooks: PreparedHooks): void {
  let releaseInvocation: "returned" | "threw" | "unavailable" = "unavailable";
  try {
    const release = client?.release;
    if (typeof release === "function") {
      releaseInvocation = "threw";
      sinkNativePromise(release.call(client, discardRequested));
      releaseInvocation = "returned";
    }
  } catch { /* one attempt only: release may have taken effect before throwing */ }
  observePrepared(hooks, { kind: "cleanup", discardRequested, releaseInvocation });
}
export function own(tx: LockedTransaction, personId: string): void {
  if (!tx.personIds.includes(personId)) fail("NOT_FOUND", 404);
}
export function query(tx: LockedTransaction, name: string, text: string, values: readonly unknown[] = []) {
  return tx.client.query({ name, text, values });
}
export class PostgresTransactions {
  private readonly pool: PgPool;
  constructor(pool: PgPool) { this.pool = pool; }
  async runPrepared<T>(options: {
    prepare: (client: PgClient) => Promise<readonly string[]>;
    beforeCommit: () => void;
    observe?: (event: PreparedRunEvent) => void;
  }, work: (tx: LockedTransaction) => Promise<T>): Promise<T> {
    // Trusted server composition, not a SQL sandbox. Capture before any await;
    // prepare must not manage transaction control, context or person locks.
    const prepare = options?.prepare, beforeCommit = options?.beforeCommit, observe = options?.observe;
    if (typeof prepare !== "function" || typeof beforeCommit !== "function" ||
        (observe !== undefined && typeof observe !== "function") || typeof work !== "function") {
      fail("RESPONSE_INVARIANT_FAILED", 500);
    }
    return this.execute(async client => {
      const derived = await prepare(client);
      if (!Array.isArray(derived) || derived.length === 0) fail("RESPONSE_INVARIANT_FAILED", 500);
      const copied: string[] = [];
      for (let i = 0; i < derived.length; i++) {
        if (!Object.hasOwn(derived, i)) fail("RESPONSE_INVARIANT_FAILED", 500);
        const id = derived[i];
        if (typeof id !== "string" || !uuid.test(id)) {
          fail("RESPONSE_INVARIANT_FAILED", 500);
        }
        copied.push(id);
      }
      const ids = Object.freeze([...new Set(copied)].sort());
      const tx = await this.lockPeople(client, ids);
      Object.defineProperties(tx, {
        personIds: { value: ids, enumerable: true, writable: false, configurable: false },
        client: { value: client, enumerable: true, writable: false, configurable: false },
      });
      return tx;
    }, work, { beforeCommit, observe });
  }
  async run<T>(personIds: readonly string[], work: (tx: LockedTransaction) => Promise<T>): Promise<T> {
    const ids = [...new Set(personIds)].sort();
    if (!ids.length || ids.some((id) => !uuid.test(id))) fail("NOT_FOUND", 404);
    return this.execute(client => this.lockPeople(client, ids), work);
  }
  async runIdentity<T>(telegramId: number, ensure: (gate: IdentityTransaction) => Promise<string>,
    work: (tx: LockedTransaction) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) fail("INIT_DATA_INVALID", 401);
    return this.execute(async client => {
      // Negative bigint keys are reserved for verified Telegram identities.
      // This lock exists before the first people row; no global identity lock.
      await client.query({ name: "ua_telegram_identity_lock", text: "SELECT pg_advisory_xact_lock($1::bigint)", values: [(-BigInt(telegramId)).toString()] });
      await client.query({name:"ua_telegram_identity_context",text:"SELECT set_config('ua.telegram_id',$1,true)",values:[String(telegramId)]});
      const personId = await ensure({client,personIds:[],now:await this.clock(client),telegramId});
      if (!uuid.test(personId)) fail("RESPONSE_INVARIANT_FAILED", 500);
      return this.lockPeople(client, [personId]);
    }, work);
  }
  private async clock(client: PgClient): Promise<number> {
    const clock = await client.query({ name: "ua_clock", text:
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms", values: [] });
    if (clock.rows.length !== 1) fail("RESPONSE_INVARIANT_FAILED", 500);
    const now = integer(clock.rows[0].now_ms);
    if (now > 8_640_000_000_000_000) fail("RESPONSE_INVARIANT_FAILED", 500);
    return now;
  }
  private async lockPeople(client: PgClient, ids: readonly string[]): Promise<LockedTransaction> {
    await client.query({name:"ua_people_context",text:"SELECT set_config('ua.person_ids',$1,true)",values:[JSON.stringify(ids)]});
    const locked = await client.query({ name: "ua_people_lock", text:
      "SELECT id::text AS id FROM ua_private.people WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", values: [ids] });
    if (locked.rows.length !== ids.length || locked.rows.some((r, i) => r.id !== ids[i])) fail("NOT_FOUND", 404);
    return {client,personIds:ids,now:await this.clock(client)};
  }
  private async execute<T>(prepare: (client: PgClient) => Promise<LockedTransaction>, work: (tx: LockedTransaction) => Promise<T>, hooks?: PreparedHooks): Promise<T> {
    if (typeof this.pool?.connect !== "function") {
      if (hooks) cleanupPrepared(undefined, true, hooks);
      throw new StorageUnavailable("not_committed");
    }
    let client: PgClient;
    try { client = await this.pool.connect(); } catch {
      if (hooks) cleanupPrepared(undefined, true, hooks);
      throw new StorageUnavailable("not_committed");
    }
    if (typeof client?.query !== "function" || typeof client.release !== "function") {
      if (hooks) cleanupPrepared(client, true, hooks);
      else if (typeof client?.release === "function") client.release(true);
      throw new StorageUnavailable("not_committed");
    }
    let began = false, committing = false, discard = false;
    try {
      await client.query({ name: "ua_begin", text: "BEGIN", values: [] }); began = true;
      const value = await work(await prepare(client));
      // Returned business-error outcomes commit maintenance transitions, including
      // deadline expiry. Throwing aborts. Never render an ACK inside this callback.
      if (hooks) {
        const result: unknown = hooks.beforeCommit();
        if (result !== undefined) {
          sinkNativePromise(result);
          fail("RESPONSE_INVARIANT_FAILED", 500);
        }
      }
      committing = true;
      await client.query({ name: "ua_commit", text: "COMMIT", values: [] }); began = false;
      if (hooks) observePrepared(hooks, { kind: "commit_ack" });
      return value;
    } catch (error) {
      if (committing) {
        discard = true;
        if (hooks) observePrepared(hooks, { kind: "commit_unknown" });
        throw new StorageUnavailable("commit_unknown");
      }
      if (began) {
        if (hooks) observePrepared(hooks, { kind: "rollback_start", error });
        try {
          await client.query({ name: "ua_rollback", text: "ROLLBACK", values: [] });
          if (hooks) observePrepared(hooks, { kind: "rollback_ack" });
        } catch {
          discard = true;
          if (hooks) observePrepared(hooks, { kind: "rollback_unknown" });
        }
      } else discard = true;
      throw error;
    } finally {
      if (hooks) cleanupPrepared(client, discard, hooks);
      else client.release(discard);
    }
  }
}
